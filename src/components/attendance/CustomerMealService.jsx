import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  buildMealServiceConfirmationRequest,
  buildMealServicePortionRequest,
  createMealServiceIdempotencyKey,
  formatMealWeight,
  normalizeMealServiceCovers,
  normalizeMealServicePortionSize,
  validateMealServiceCovers
} from '@/lib/mealServiceAttendance';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, History, Loader2, PackageCheck, QrCode, RefreshCw, RotateCcw, Save } from 'lucide-react';
import {
  getMenuCategoryOptions,
  MENU_CUISINE_OPTIONS
} from '../../../shared/menuCategories.js';
import { formatProductionEventTitle } from '../../../shared/productionLabels.js';

const MEAL_PERIODS = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' }
];

function todayString() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function initialScope() {
  return {
    service_date: todayString(),
    site_id: '',
    menu_type: 'general',
    menu_category: 'senior',
    meal_type: 'lunch'
  };
}

function scopeFromUrl() {
  const fallback = initialScope();
  if (typeof window === 'undefined') return fallback;
  const params = new URLSearchParams(window.location.search);
  const menuType = MENU_CUISINE_OPTIONS.some((option) => option.value === params.get('menu_type'))
    ? params.get('menu_type')
    : fallback.menu_type;
  const categoryOptions = getMenuCategoryOptions(menuType);
  const menuCategory = categoryOptions.some((option) => option.value === params.get('menu_category'))
    ? params.get('menu_category')
    : fallback.menu_category;
  const mealType = MEAL_PERIODS.some((option) => option.value === params.get('meal_type'))
    ? params.get('meal_type')
    : fallback.meal_type;
  return {
    service_date: params.get('service_date') || params.get('date') || fallback.service_date,
    site_id: params.get('site_id') || fallback.site_id,
    menu_type: menuType,
    menu_category: menuCategory,
    meal_type: mealType
  };
}

function buildCoversQrUrl(scope) {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams({
    service_date: scope.service_date || '',
    site_id: scope.site_id || '',
    menu_type: scope.menu_type || 'general',
    menu_category: scope.menu_category || 'senior',
    meal_type: scope.meal_type || 'lunch'
  });
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function buildEmployeeQrScannerUrl(scope, selectedProjectLabel) {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams({
    service_date: scope.service_date || '',
    site_id: scope.site_id || '',
    site_name: selectedProjectLabel || '',
    menu_type: scope.menu_type || 'general',
    menu_category: scope.menu_category || 'senior',
    meal_type: scope.meal_type || 'lunch'
  });
  return `${window.location.origin}${createPageUrl('EmployeeMealQRScanner')}?${params.toString()}`;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDateTime(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatLabel(value) {
  return String(value || '-')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getConfirmedServicePortion(item = {}) {
  return normalizeMealServicePortionSize(item.service_portion_size_grams);
}

function InlineNotice({ tone = 'neutral', children }) {
  const toneClasses = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    neutral: 'border-slate-200 bg-slate-50 text-slate-700'
  };
  return <div className={`rounded-xl border px-4 py-3 text-sm ${toneClasses[tone]}`}>{children}</div>;
}

export function CustomerMealServicePanel({
  locationOptions = [],
  isAdmin = false,
  canConfirm = false,
  canGenerateCoversQr = false
}) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState(scopeFromUrl);
  const [coversByRecipe, setCoversByRecipe] = useState({});
  const [portionDrafts, setPortionDrafts] = useState({});
  const [idempotencyKey, setIdempotencyKey] = useState(createMealServiceIdempotencyKey);
  const [notice, setNotice] = useState(null);
  const [confirmationResult, setConfirmationResult] = useState(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [reverseDialog, setReverseDialog] = useState({
    open: false,
    record: null,
    reason: '',
    idempotencyKey: ''
  });
  const lastAvailabilityRef = useRef({ scopeKey: '', snapshot: '' });
  const categoryOptions = useMemo(() => getMenuCategoryOptions(scope.menu_type), [scope.menu_type]);
  const hasCompleteScope = Boolean(
    scope.service_date
    && scope.site_id
    && scope.menu_type
    && scope.menu_category
    && scope.meal_type
  );

  const availabilityQuery = useQuery({
    queryKey: [
      'mealServiceAvailability',
      scope.site_id,
      scope.service_date,
      scope.meal_type,
      scope.menu_type,
      scope.menu_category
    ],
    queryFn: () => base44.mealService.availability(scope),
    enabled: hasCompleteScope,
    retry: 1
  });

  const historyQuery = useQuery({
    queryKey: [
      'mealServiceHistory',
      scope.site_id,
      scope.service_date,
      scope.meal_type,
      scope.menu_type,
      scope.menu_category
    ],
    queryFn: () => base44.mealService.report({
      site_id: scope.site_id,
      start_date: scope.service_date,
      end_date: scope.service_date,
      meal_type: scope.meal_type,
      menu_type: scope.menu_type,
      menu_category: scope.menu_category
    }),
    enabled: hasCompleteScope,
    retry: 1
  });

  const availableDishes = useMemo(() => (
    availabilityQuery.data?.dishes
    || availabilityQuery.data?.items
    || []
  ), [availabilityQuery.data]);
  const availabilitySnapshot = String(availabilityQuery.data?.availability_snapshot || '').trim();
  const availabilityScopeKey = [
    scope.site_id,
    scope.service_date,
    scope.meal_type,
    scope.menu_type,
    scope.menu_category
  ].join('|');
  const latestConfirmation = confirmationResult?.attendance || availabilityQuery.data?.confirmation || null;
  const displayedDishes = availableDishes;
  const historyRows = useMemo(() => (historyQuery.data?.rows || []).filter((record) => (
    String(record.site_id || '') === String(scope.site_id)
    && record.service_date === scope.service_date
    && String(record.meal_type || '').toLowerCase() === scope.meal_type
    && String(record.menu_type || '').toLowerCase() === scope.menu_type
    && String(record.menu_category || '').toLowerCase() === scope.menu_category
  )), [historyQuery.data, scope]);
  const activeHistoryRows = useMemo(
    () => historyRows.filter((record) => String(record.status || '').toLowerCase() !== 'reversed'),
    [historyRows]
  );
  const activeHistoryServedWeight = activeHistoryRows.reduce(
    (total, record) => total + asNumber(record.served_weight_grams),
    0
  );
  const activeHistoryDishCovers = activeHistoryRows.reduce(
    (total, record) => total + (record.items || []).reduce(
      (itemTotal, item) => itemTotal + asNumber(item.covers ?? item.required_servings),
      0
    ),
    0
  );

  useEffect(() => {
    if (!hasCompleteScope || !availabilitySnapshot) return;
    const previous = lastAvailabilityRef.current;
    const sameScope = previous.scopeKey === availabilityScopeKey;
    const snapshotChanged = sameScope
      && Boolean(previous.snapshot)
      && previous.snapshot !== availabilitySnapshot;
    if (previous.scopeKey !== availabilityScopeKey || previous.snapshot !== availabilitySnapshot) {
      lastAvailabilityRef.current = { scopeKey: availabilityScopeKey, snapshot: availabilitySnapshot };
      setIdempotencyKey(createMealServiceIdempotencyKey());
    }
    if (!snapshotChanged) return;
    const hadEnteredCovers = Object.values(coversByRecipe).some((value) => value !== '');
    setCoversByRecipe({});
    if (hadEnteredCovers) {
      setNotice({
        tone: 'warning',
        text: 'Prepared output changed after covers were entered. Review the refreshed balances and enter covers again.'
      });
    }
  }, [
    availabilityScopeKey,
    availabilitySnapshot,
    coversByRecipe,
    hasCompleteScope
  ]);

  useEffect(() => {
    setCoversByRecipe((current) => Object.fromEntries(
      availableDishes.map((dish) => [
        dish.recipe_id,
        Object.prototype.hasOwnProperty.call(current, dish.recipe_id) ? current[dish.recipe_id] : ''
      ])
    ));
    setPortionDrafts(Object.fromEntries(
      availableDishes.map((dish) => [dish.recipe_id, String(dish.service_portion_size_grams ?? '')])
    ));
  }, [availableDishes]);

  const coversValidation = useMemo(
    () => validateMealServiceCovers(availableDishes, coversByRecipe),
    [availableDishes, coversByRecipe]
  );
  const hasUnsavedPortionChanges = isAdmin && availableDishes.some((dish) => (
    normalizeMealServicePortionSize(portionDrafts[dish.recipe_id])
    !== normalizeMealServicePortionSize(dish.service_portion_size_grams)
  ));
  const confirmationRequest = useMemo(() => buildMealServiceConfirmationRequest(
    scope,
    availableDishes,
    coversByRecipe,
    idempotencyKey,
    availabilitySnapshot
  ), [availabilitySnapshot, availableDishes, coversByRecipe, idempotencyKey, scope]);

  const changeScope = (changes) => {
    lastAvailabilityRef.current = { scopeKey: '', snapshot: '' };
    setScope((current) => ({ ...current, ...changes }));
    setCoversByRecipe({});
    setPortionDrafts({});
    setConfirmationResult(null);
    setConfirmDialogOpen(false);
    setReverseDialog({ open: false, record: null, reason: '', idempotencyKey: '' });
    setNotice(null);
    setIdempotencyKey(createMealServiceIdempotencyKey());
  };

  const updateCovers = (recipeId, value) => {
    if (value !== '' && !/^\d+$/.test(value)) return;
    setCoversByRecipe((current) => ({ ...current, [recipeId]: value }));
    setNotice(null);
    setIdempotencyKey(createMealServiceIdempotencyKey());
  };

  const portionMutation = useMutation({
    mutationFn: ({ dish, value }) => base44.mealService.updatePortionSize(
      buildMealServicePortionRequest(scope, dish, value)
    ),
    onSuccess: async (result) => {
      setNotice({
        tone: 'success',
        text: `${result?.dish?.recipe_name || 'Dish'} portion size was updated successfully.`
      });
      await queryClient.invalidateQueries({ queryKey: ['mealServiceAvailability'] });
      await availabilityQuery.refetch();
    },
    onError: (error) => setNotice({ tone: 'error', text: error.message || 'Portion size could not be updated.' })
  });

  const confirmationMutation = useMutation({
    mutationFn: () => base44.mealService.confirm(confirmationRequest),
    onSuccess: async (result) => {
      setConfirmationResult(result);
      setConfirmDialogOpen(false);
      setNotice({
        tone: 'success',
        text: result?.replayed
          ? 'This Meal Service request was already saved. The original report is shown.'
          : 'Meal Service saved. Produced quantities were deducted item by item and a detailed report was recorded.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mealServiceAvailability'] }),
        queryClient.invalidateQueries({ queryKey: ['mealServiceHistory'] }),
        queryClient.invalidateQueries({ queryKey: ['foodWaste'] })
      ]);
      setCoversByRecipe({});
      setIdempotencyKey(createMealServiceIdempotencyKey());
      await Promise.all([availabilityQuery.refetch(), historyQuery.refetch()]);
    },
    onError: (error) => {
      const errorMessage = error.message || 'Meal Service could not be saved.';
      const requiresAvailabilityRefresh = error.status === 409
        && /availability|snapshot|changed|stale|refresh/i.test(errorMessage);
      setNotice({
        tone: 'error',
        text: requiresAvailabilityRefresh
          ? `${errorMessage} Refresh the fully produced dishes, review the current balances, and enter covers again.`
          : errorMessage
      });
      if (requiresAvailabilityRefresh) {
        setConfirmDialogOpen(false);
        setCoversByRecipe({});
        setIdempotencyKey(createMealServiceIdempotencyKey());
      }
      if (error.status === 409) availabilityQuery.refetch();
    }
  });

  const reverseMutation = useMutation({
    mutationFn: ({ record, reason, reversalKey }) => base44.mealService.reverseAttendance(
      record.attendance_id || record.id,
      { reason: reason.trim(), idempotency_key: reversalKey }
    ),
    onSuccess: async (result) => {
      setReverseDialog({ open: false, record: null, reason: '', idempotencyKey: '' });
      setConfirmationResult(null);
      setCoversByRecipe({});
      setPortionDrafts({});
      setIdempotencyKey(createMealServiceIdempotencyKey());
      setNotice({
        tone: 'success',
        text: result?.replayed
          ? 'This reversal was already completed. The current service history is shown.'
          : 'Meal Service reversed. Prepared output was restored and a corrected request can now be saved.'
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mealServiceAvailability'] }),
        queryClient.invalidateQueries({ queryKey: ['mealServiceHistory'] }),
        queryClient.invalidateQueries({ queryKey: ['foodWaste'] })
      ]);
      await Promise.all([availabilityQuery.refetch(), historyQuery.refetch()]);
    },
    onError: (error) => {
      setNotice({ tone: 'error', text: error.message || 'Meal service could not be reversed.' });
      if (error.status === 409) {
        availabilityQuery.refetch();
        historyQuery.refetch();
      }
    }
  });

  const submitConfirmation = (event) => {
    event.preventDefault();
    if (!availabilitySnapshot) {
      setNotice({ tone: 'error', text: 'Production availability is not current. Refresh the fully produced dishes before saving Meal Service.' });
      availabilityQuery.refetch();
      return;
    }
    if (!coversValidation.valid) {
      setNotice({ tone: 'error', text: coversValidation.message });
      return;
    }
    setConfirmDialogOpen(true);
  };

  const savePortionSize = (dish) => {
    const value = portionDrafts[dish.recipe_id];
    if (normalizeMealServicePortionSize(value) === null) {
      setNotice({ tone: 'error', text: 'Portion size must be greater than 0 and no more than 100,000 grams.' });
      return;
    }
    portionMutation.mutate({ dish, value });
  };

  const openReverseDialog = (record) => {
    setReverseDialog({
      open: true,
      record,
      reason: '',
      idempotencyKey: createMealServiceIdempotencyKey()
    });
  };

  const submitReversal = () => {
    if (!reverseDialog.record || !reverseDialog.reason.trim()) return;
    reverseMutation.mutate({
      record: reverseDialog.record,
      reason: reverseDialog.reason,
      reversalKey: reverseDialog.idempotencyKey
    });
  };

  const summary = availabilityQuery.data?.summary || {};
  const confirmationReference = latestConfirmation?.service_reference || latestConfirmation?.id;
  const coversQrUrl = useMemo(() => buildCoversQrUrl(scope), [scope]);
  const selectedProjectLabel = locationOptions.find((site) => String(site.id) === String(scope.site_id))?.hierarchy_path
    || locationOptions.find((site) => String(site.id) === String(scope.site_id))?.name
    || 'Selected project';
  const employeeQrScannerUrl = useMemo(() => buildEmployeeQrScannerUrl(scope, selectedProjectLabel), [scope, selectedProjectLabel]);
  const requestedCovers = availableDishes.reduce(
    (total, dish) => total + (normalizeMealServiceCovers(coversByRecipe[dish.recipe_id]) || 0),
    0
  );
  const requestedWeightGrams = availableDishes.reduce(
    (total, dish) => total + (
      (normalizeMealServiceCovers(coversByRecipe[dish.recipe_id]) || 0)
      * asNumber(dish.service_portion_size_grams)
    ),
    0
  );

  return (
    <>
      <form className="space-y-5" onSubmit={submitConfirmation}>
      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Meal Service</CardTitle>
              <p className="mt-1 text-sm text-slate-500">
                Select the 5 scope filters to load produced dishes, enter covers, and save each meal-service request.
              </p>
            </div>
            <Badge className={isAdmin ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-700'}>
              {isAdmin ? 'Admin portion editing' : 'Portion sizes read-only'}
            </Badge>
            {canGenerateCoversQr && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!hasCompleteScope}
                  onClick={() => setQrDialogOpen(true)}
                  title={hasCompleteScope ? 'Generate a QR code for this selected covers scope' : 'Select date, project, menu type, menu category, and meal period first'}
                >
                  <QrCode className="mr-2 h-4 w-4" />
                  Covers QR
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!hasCompleteScope}
                  asChild={hasCompleteScope}
                  title={hasCompleteScope ? 'Open QR scanner for this selected date, project, menu type, menu category, and meal period' : 'Select date, project, menu type, menu category, and meal period first'}
                >
                  {hasCompleteScope ? (
                    <a href={employeeQrScannerUrl} target="_blank" rel="noreferrer">
                      <QrCode className="mr-2 h-4 w-4" />
                      QR Scanner
                    </a>
                  ) : (
                    <>
                      <QrCode className="mr-2 h-4 w-4" />
                      QR Scanner
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <div>
              <Label htmlFor="meal-service-date">Date</Label>
              <Input
                id="meal-service-date"
                type="date"
                className="mt-1"
                value={scope.service_date}
                onChange={(event) => changeScope({ service_date: event.target.value })}
              />
            </div>
            <div>
              <Label>Project</Label>
              <Select value={scope.site_id} onValueChange={(value) => changeScope({ site_id: value })}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {locationOptions.map((site) => (
                    <SelectItem key={site.id} value={String(site.id)}>{site.hierarchy_path || site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Menu Type</Label>
              <Select
                value={scope.menu_type}
                onValueChange={(value) => {
                  const categories = getMenuCategoryOptions(value);
                  const menuCategory = categories.some((option) => option.value === scope.menu_category)
                    ? scope.menu_category
                    : categories[0]?.value || 'senior';
                  changeScope({ menu_type: value, menu_category: menuCategory });
                }}
              >
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MENU_CUISINE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Menu Category</Label>
              <Select value={scope.menu_category} onValueChange={(value) => changeScope({ menu_category: value })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Meal Period</Label>
              <Select value={scope.meal_type} onValueChange={(value) => changeScope({ meal_type: value })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MEAL_PERIODS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Fully Produced Dishes</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Covers consume the configured portion weight from completed production output. Raw ingredient inventory is not changed here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasCompleteScope && !availabilityQuery.isLoading ? (
              <Badge className={latestConfirmation ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}>
                {latestConfirmation ? 'Latest request saved' : `${asNumber(summary.prepared_meal_count)} dishes`}
              </Badge>
            ) : null}
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Refresh fully produced dishes"
              disabled={!hasCompleteScope || availabilityQuery.isFetching}
              onClick={() => availabilityQuery.refetch()}
            >
              <RefreshCw className={`h-4 w-4 ${availabilityQuery.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!scope.site_id ? (
            <InlineNotice>Select a project to load the day&apos;s fully produced dishes.</InlineNotice>
          ) : availabilityQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading fully produced dishes...
            </div>
          ) : availabilityQuery.isError ? (
            <InlineNotice tone="error">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{availabilityQuery.error?.message || 'Fully produced dishes could not be loaded.'}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => availabilityQuery.refetch()}>Try again</Button>
              </div>
            </InlineNotice>
          ) : displayedDishes.length === 0 ? (
            <InlineNotice tone="warning">
              No fully produced dishes match this date, project, menu type, menu category, and meal period.
            </InlineNotice>
          ) : (
            <>
              {latestConfirmation ? (
                <InlineNotice tone="success">
                  <span className="font-medium">Latest Meal Service request saved.</span>
                  {confirmationReference ? ` Reference: ${confirmationReference}.` : ''} Additional requests can still be saved while prepared quantity remains available.
                </InlineNotice>
              ) : null}
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dish</TableHead>
                      <TableHead>Prepared Qty</TableHead>
                      <TableHead>Portion Size</TableHead>
                      <TableHead>No. Of Covers</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayedDishes.map((dish) => {
                      const recipeId = dish.recipe_id;
                      const dishTitle = formatProductionEventTitle(dish, {
                        fallback: dish.recipe_name || 'Prepared dish'
                      });
                      const configuredPortion = normalizeMealServicePortionSize(dish.service_portion_size_grams);
                      const availableCoversValue = Number(dish.available_covers);
                      const availableCovers = configuredPortion !== null
                        && dish.available_covers !== null
                        && typeof dish.available_covers !== 'undefined'
                        && dish.available_covers !== ''
                        && Number.isInteger(availableCoversValue)
                        && availableCoversValue >= 0
                        ? availableCoversValue
                        : null;
                      const coverValue = coversByRecipe[recipeId] ?? '';
                      const normalizedCovers = normalizeMealServiceCovers(coverValue);
                      const exceedsAvailable = availableCovers !== null
                        && normalizedCovers !== null
                        && normalizedCovers > availableCovers;
                      const portionValue = portionDrafts[recipeId] ?? String(dish.service_portion_size_grams ?? '');
                      const portionChanged = normalizeMealServicePortionSize(portionValue) !== normalizeMealServicePortionSize(dish.service_portion_size_grams);
                      return (
                        <TableRow key={recipeId}>
                          <TableCell>
                            <p className="font-medium text-slate-900">{dishTitle}</p>
                            <p className="mt-1 text-xs text-slate-500">{asNumber(dish.batch_count)} completed batch{asNumber(dish.batch_count) === 1 ? '' : 'es'}</p>
                            {Array.isArray(dish.production_names) && dish.production_names.length > 0 ? (
                              <p className="mt-1 text-xs text-slate-500">
                                Production event{dish.production_names.length === 1 ? '' : 's'}: {dish.production_names.join(', ')}
                              </p>
                            ) : null}
                            {Array.isArray(dish.consumption_report_ids) && dish.consumption_report_ids.length > 0 ? (
                              <p className="mt-1 text-xs font-medium text-emerald-700">
                                Production consumption report available
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="min-w-[210px]">
                            <p className="font-medium text-slate-900">{formatMealWeight(dish.available_weight_grams)}</p>
                            <p className="mt-1 text-xs text-slate-600">
                              {availableCovers === null ? 'Covers available after portion setup' : `${availableCovers} covers available`}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Produced {formatMealWeight(dish.produced_weight_grams)}
                            </p>
                          </TableCell>
                          <TableCell className="min-w-[230px]">
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                min="0.001"
                                max="100000"
                                step="0.001"
                                inputMode="decimal"
                                aria-label={`${dish.recipe_name || 'Dish'} portion size in grams`}
                                value={isAdmin ? portionValue : dish.service_portion_size_grams ?? ''}
                                disabled={!isAdmin || portionMutation.isPending}
                                onChange={(event) => setPortionDrafts((current) => ({ ...current, [recipeId]: event.target.value }))}
                                className={!isAdmin ? 'bg-slate-100 text-slate-500 disabled:cursor-not-allowed disabled:opacity-100' : ''}
                              />
                              <span className="text-sm text-slate-500">g</span>
                              {isAdmin ? (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  aria-label={`Save ${dish.recipe_name || 'dish'} portion size`}
                                  disabled={
                                    portionMutation.isPending
                                    || normalizeMealServicePortionSize(portionValue) === null
                                    || !portionChanged
                                  }
                                  onClick={() => savePortionSize(dish)}
                                >
                                  {portionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                </Button>
                              ) : null}
                            </div>
                            {configuredPortion === null ? (
                              <p className="mt-1 text-xs font-medium text-amber-700">
                                Unconfigured — {isAdmin ? 'enter and save a manual service portion.' : 'ask an administrator to set the manual service portion.'}
                              </p>
                            ) : !isAdmin ? (
                              <p className="mt-1 text-xs text-slate-500">Admin controlled</p>
                            ) : (
                              <p className="mt-1 text-xs text-slate-500">Saved manual service portion</p>
                            )}
                          </TableCell>
                          <TableCell className="min-w-[190px]">
                            <Input
                              type="number"
                              min="0"
                              max={availableCovers ?? undefined}
                              step="1"
                              inputMode="numeric"
                              aria-label={`${dish.recipe_name || 'Dish'} number of covers`}
                              placeholder="Enter covers"
                              value={coverValue}
                              disabled={!canConfirm || availableCovers === null}
                              onChange={(event) => updateCovers(recipeId, event.target.value)}
                              className={!canConfirm || availableCovers === null ? 'bg-slate-100 text-slate-500 disabled:cursor-not-allowed disabled:opacity-100' : ''}
                            />
                            {exceedsAvailable ? (
                              <p className="mt-1 text-xs font-medium text-red-600">Maximum available: {availableCovers}</p>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {!canConfirm && hasCompleteScope ? (
            <InlineNotice tone="warning">You have read-only access. A user with Meal Service recording permission must save the covers.</InlineNotice>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <div className="text-sm text-slate-600">
              {hasCompleteScope && !availabilityQuery.isLoading && !availabilitySnapshot ? (
                <span className="flex items-center gap-2 text-amber-700"><AlertTriangle className="h-4 w-4" /> Refresh the produced dishes before entering covers</span>
              ) : coversValidation.valid ? (
                hasUnsavedPortionChanges ? (
                  <span className="flex items-center gap-2 text-amber-700"><AlertTriangle className="h-4 w-4" /> Save all portion-size changes before saving Meal Service</span>
                ) : (
                  <span className="flex items-center gap-2 text-emerald-700"><PackageCheck className="h-4 w-4" /> Covers are valid for the available output</span>
                )
              ) : (
                <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /> {coversValidation.message}</span>
              )}
            </div>
            <Button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={
                !canConfirm
                || !hasCompleteScope
                || !availabilitySnapshot
                || !coversValidation.valid
                || hasUnsavedPortionChanges
                || availabilityQuery.isLoading
                || availabilityQuery.isError
                || confirmationMutation.isPending
                || portionMutation.isPending
              }
            >
              {confirmationMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Save Meal Service
            </Button>
          </div>
        </CardContent>
      </Card>
      </form>

      <Card className="mt-5 border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" /> Meal Service Reports &amp; History
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Detailed saved reports for this exact date, project, menu type, menu category, and meal period.
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Refresh Meal Service history"
            disabled={!hasCompleteScope || historyQuery.isFetching}
            onClick={() => historyQuery.refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${historyQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {!scope.site_id ? (
            <InlineNotice>Select a project to view Meal Service history.</InlineNotice>
          ) : historyQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading service history...
            </div>
          ) : historyQuery.isError ? (
            <InlineNotice tone="error">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{historyQuery.error?.message || 'Service history could not be loaded.'}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => historyQuery.refetch()}>Try again</Button>
              </div>
            </InlineNotice>
          ) : historyRows.length === 0 ? (
            <InlineNotice>No Meal Service request has been saved for this selected production scope.</InlineNotice>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active Requests</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{activeHistoryRows.length}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Served Weight</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{formatMealWeight(activeHistoryServedWeight)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Dish Covers</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{activeHistoryDishCovers}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Reversed Records</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{historyRows.length - activeHistoryRows.length}</p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Confirmed By / Time</TableHead>
                      <TableHead>Served</TableHead>
                      <TableHead>Prepared Dishes</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyRows.map((record) => {
                      const reversed = String(record.status || '').toLowerCase() === 'reversed';
                      return (
                        <TableRow key={record.attendance_id || record.id}>
                          <TableCell className="min-w-[170px]">
                            <p className="font-medium text-slate-900">{record.service_reference || record.attendance_id}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              {formatLabel(record.menu_type)} · {formatLabel(record.menu_category)} · {formatLabel(record.meal_type)}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge className={reversed ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-700'}>
                              {reversed ? 'Reversed' : 'Confirmed'}
                            </Badge>
                            {reversed && record.reversal_reason ? (
                              <p className="mt-2 max-w-[260px] text-xs text-slate-600">Reason: {record.reversal_reason}</p>
                            ) : null}
                          </TableCell>
                          <TableCell className="min-w-[210px]">
                            <p className="text-sm text-slate-800">{record.recorded_by_name || 'Recorded user'}</p>
                            <p className="mt-1 text-xs text-slate-500">{formatDateTime(record.recorded_at)}</p>
                            {reversed ? (
                              <p className="mt-2 text-xs text-slate-500">
                                Reversed by {record.reversed_by_name || 'administrator'} · {formatDateTime(record.reversed_at)}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="min-w-[150px]">
                            <p className="font-medium text-slate-900">{formatMealWeight(record.served_weight_grams)}</p>
                            {asNumber(record.plate_waste_weight_grams) > 0 ? (
                              <p className="mt-1 text-xs font-semibold text-red-600">
                                Plate waste deducted: {formatMealWeight(record.plate_waste_weight_grams)}
                              </p>
                            ) : null}
                            <p className="mt-1 text-xs text-slate-500">
                              {(record.items || []).reduce(
                                (total, item) => total + asNumber(item.covers ?? item.required_servings),
                                0
                              )} dish covers
                            </p>
                          </TableCell>
                          <TableCell className="min-w-[280px]">
                            {(record.items || []).length ? (record.items || []).map((item) => {
                              const portion = getConfirmedServicePortion(item);
                              return (
                                <p key={`${record.attendance_id || record.id}-${item.recipe_id}`} className="text-xs text-slate-600">
                                  <span className="font-medium text-slate-800">{item.recipe_name || 'Prepared dish'}:</span>{' '}
                                  {asNumber(item.covers ?? item.required_servings)} covers
                                  {portion === null ? ' · portion snapshot unavailable' : ` × ${formatMealWeight(portion)}`}
                                </p>
                              );
                            }) : <span className="text-xs text-slate-500">No dish detail</span>}
                          </TableCell>
                          <TableCell>
                            {isAdmin && !reversed ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="whitespace-nowrap border-amber-300 text-amber-800 hover:bg-amber-50"
                                disabled={reverseMutation.isPending}
                                onClick={() => openReverseDialog(record)}
                              >
                                <RotateCcw className="mr-2 h-4 w-4" /> Reverse / Correct Meal Service
                              </Button>
                            ) : reversed ? (
                              <span className="text-xs text-slate-500">Retained for audit</span>
                            ) : (
                              <span className="text-xs text-slate-500">Locked</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmDialogOpen} onOpenChange={(open) => !confirmationMutation.isPending && setConfirmDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this Meal Service request?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <InlineNotice tone="warning">
              This saves a new Meal Service request for the selected date, project, meal period, menu type, and menu category.
            </InlineNotice>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <p><span className="font-medium text-slate-900">Served weight:</span> portion size × covers for every dish.</p>
              <p className="mt-2"><span className="font-medium text-slate-900">Total dish covers:</span> {requestedCovers}</p>
              <p className="mt-1"><span className="font-medium text-slate-900">Total served weight:</span> {formatMealWeight(requestedWeightGrams)}</p>
            </div>
            <p className="text-sm font-medium text-red-700">
              The entered covers will deduct prepared production item by item. Any remaining prepared quantity stays available for another Meal Service request or waste recording.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={confirmationMutation.isPending} onClick={() => setConfirmDialogOpen(false)}>
              Go Back
            </Button>
            <Button
              type="button"
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={confirmationMutation.isPending}
              onClick={() => confirmationMutation.mutate()}
            >
              {confirmationMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Save Meal Service
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reverseDialog.open}
        onOpenChange={(open) => {
          if (open || reverseMutation.isPending) return;
          setReverseDialog({ open: false, record: null, reason: '', idempotencyKey: '' });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse / Correct Meal Service</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <InlineNotice tone="warning">
              This admin-only action reverses the selected Meal Service request, restores its prepared-output balances, and reverses any related system waste entries. The audit record remains visible.
            </InlineNotice>
            <div>
              <Label htmlFor="meal-service-reversal-reason">Reason for correction</Label>
              <Input
                id="meal-service-reversal-reason"
                className="mt-1"
                value={reverseDialog.reason}
                disabled={reverseMutation.isPending}
                placeholder="Explain why this service must be corrected"
                maxLength={500}
                onChange={(event) => setReverseDialog((current) => ({ ...current, reason: event.target.value }))}
              />
              <p className="mt-1 text-xs text-slate-500">A reason is required and will be retained in service history.</p>
            </div>
            <p className="text-sm text-slate-600">
              After reversal, enter the corrected covers and use Save Meal Service to create a corrected request.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={reverseMutation.isPending}
              onClick={() => setReverseDialog({ open: false, record: null, reason: '', idempotencyKey: '' })}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!reverseDialog.reason.trim() || reverseMutation.isPending}
              onClick={submitReversal}
            >
              {reverseMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
              Reverse and Allow Correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Meal Service Covers QR Code</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <p className="font-medium text-slate-900">{selectedProjectLabel}</p>
              <p className="mt-1">{scope.service_date} · {formatLabel(scope.menu_type)} · {formatLabel(scope.menu_category)} · {formatLabel(scope.meal_type)}</p>
            </div>
            <div className="flex justify-center rounded-xl border border-slate-200 bg-white p-4">
              {coversQrUrl && (
                <QRCodeSVG value={coversQrUrl} size={220} level="H" includeMargin bgColor="#ffffff" fgColor="#0f172a" />
              )}
            </div>
            <div>
              <Label htmlFor="staff-covers-qr-link">QR link</Label>
              <Input id="staff-covers-qr-link" className="mt-1" readOnly value={coversQrUrl} />
            </div>
            <p className="text-sm text-slate-500">
              Scanning opens Food Consumption with this exact Meal Service scope selected for entry.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => navigator.clipboard?.writeText(coversQrUrl)}>
              <Copy className="mr-2 h-4 w-4" />
              Copy Link
            </Button>
            <Button type="button" asChild>
              <a href={coversQrUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
