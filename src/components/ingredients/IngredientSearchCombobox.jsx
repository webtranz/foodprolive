import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Check, ChevronsUpDown, Loader2, Search, ShieldAlert } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatCurrency, formatNumber } from '@/lib/currency';
import { splitHighlightedIngredientText } from '../../../shared/ingredientSearch.js';
import { getItemCode } from '../../../shared/itemCode.js';

function useDebouncedValue(value, delay = 250) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);
  return debouncedValue;
}

function HighlightedText({ value, query }) {
  return splitHighlightedIngredientText(value, query).map((part, index) => (
    part.match ? (
      <mark key={`${part.text}-${index}`} className="rounded-sm bg-amber-200 px-0.5 text-inherit">
        {part.text}
      </mark>
    ) : <React.Fragment key={`${part.text}-${index}`}>{part.text}</React.Fragment>
  ));
}

function allergenList(ingredient) {
  if (Array.isArray(ingredient.allergens)) return ingredient.allergens.filter(Boolean);
  return ingredient.allergens ? [ingredient.allergens] : [];
}

function indexedLabel(count) {
  if (Number(count) >= 5000) return `${formatNumber(Math.floor(Number(count) / 1000) * 1000)}+ SKUs indexed`;
  return `${formatNumber(count || 0)} active SKUs indexed`;
}

function ingredientHoverText(ingredient) {
  if (!ingredient) return '';
  const details = [
    getItemCode(ingredient),
    ingredient.name || 'Unnamed item',
    ingredient.category ? `Category: ${ingredient.category}` : '',
    ingredient.unit ? `Unit: ${ingredient.unit}` : '',
    typeof ingredient.current_stock !== 'undefined'
      ? `Stock: ${formatNumber(ingredient.current_stock || 0, 2)} ${ingredient.stock_unit || ingredient.unit || ''}`.trim()
      : ''
  ].filter(Boolean);
  return details.join(' · ');
}

export default function IngredientSearchCombobox({
  value = '',
  onValueChange,
  selectedIngredient = null,
  siteId = '',
  stockOnly = false,
  placeholder = 'Search ingredient, SKU, category or alias…',
  allowClear = false,
  clearLabel = 'No ingredient',
  disabled = false,
  className = ''
}) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [viewAll, setViewAll] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 250);
  const limit = viewAll ? 50 : 20;

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, viewAll]);

  useEffect(() => {
    if (!open) return undefined;
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [open]);

  const query = useQuery({
    queryKey: ['ingredient-search', debouncedSearch, page, limit, siteId, stockOnly],
    queryFn: () => base44.ingredients.search({
      q: debouncedSearch,
      page,
      limit,
      site_id: siteId || undefined,
      stock_only: stockOnly || undefined
    }),
    enabled: open,
    staleTime: 30_000,
    retry: 1
  });

  const items = query.data?.items || [];
  const totalCount = Number(query.data?.total_count || 0);
  const totalPages = Number(query.data?.total_pages || 1);
  const isDebouncing = search !== debouncedSearch;
  const visibleSearch = debouncedSearch;
  const selectedLabel = selectedIngredient
    ? `${getItemCode(selectedIngredient)} · ${selectedIngredient.name || 'Unnamed item'}`
    : (value ? 'Selected ingredient' : '');
  const selectedHoverText = selectedIngredient
    ? ingredientHoverText(selectedIngredient)
    : (selectedLabel || placeholder);

  const resultDescription = useMemo(() => {
    if (query.isError) return 'Ingredient search unavailable';
    if (query.isFetching || isDebouncing) return 'Searching ingredients';
    if (!query.data) return 'Type to search ingredients';
    return `${totalCount} ingredient${totalCount === 1 ? '' : 's'} found`;
  }, [isDebouncing, query.data, query.isError, query.isFetching, totalCount]);

  const chooseIngredient = (ingredient) => {
    onValueChange?.(ingredient?.id || '', ingredient || null);
    setOpen(false);
    setSearch('');
    setViewAll(false);
    setPage(1);
  };

  const handleOpenChange = (nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch('');
      setViewAll(false);
      setPage(1);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Select ingredient"
          title={selectedHoverText}
          disabled={disabled}
          className={cn('h-10 w-full justify-between bg-white px-3 font-normal', !selectedLabel && 'text-muted-foreground', className)}
        >
          <span className="min-w-0 truncate text-left" title={selectedHoverText}>{selectedLabel || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(760px,calc(100vw-2rem))] overflow-hidden p-0"
        onEscapeKeyDown={() => setOpen(false)}
      >
        <Command shouldFilter={false} aria-label="Search ingredients">
          <CommandInput
            ref={inputRef}
            value={search}
            onValueChange={setSearch}
            placeholder={placeholder}
            aria-describedby="ingredient-search-status"
          />

          <div id="ingredient-search-status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 border-b bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-full', query.isError ? 'bg-red-500' : 'bg-emerald-500')} />
              {query.data ? indexedLabel(query.data.indexed_count) : 'Indexed ingredient search'}
            </span>
            <span>{resultDescription}{query.data && !query.isFetching ? ` in ${query.data.elapsed_ms} ms` : ''}</span>
          </div>

          <div className="hidden grid-cols-[110px_minmax(180px,1.5fr)_120px_60px_95px_100px_100px] gap-2 border-b bg-white px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:grid">
            <span>Item Code</span><span>Item Name</span><span>Category</span><span>Unit</span><span>Stock</span><span>Last cost</span><span>Allergen</span>
          </div>

          <CommandList className="max-h-[390px]">
            {allowClear ? (
              <CommandGroup>
                <CommandItem value="__clear__" onSelect={() => chooseIngredient(null)} className="min-h-11 px-3">
                  <Check className={cn('h-4 w-4', !value ? 'opacity-100' : 'opacity-0')} />
                  {clearLabel}
                </CommandItem>
              </CommandGroup>
            ) : null}

            {query.isFetching || isDebouncing ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching the indexed catalog…
              </div>
            ) : null}

            {query.isError && !query.isFetching ? (
              <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-red-700">
                <AlertCircle className="h-5 w-5" />
                <span>{query.error?.message || 'Ingredient search could not be loaded.'}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()}>Try again</Button>
              </div>
            ) : null}

            {!query.isFetching && !isDebouncing && !query.isError && items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                {visibleSearch ? `No active ingredients match “${visibleSearch}”.` : 'No active ingredients are available.'}
              </div>
            ) : null}

            {!query.isFetching && !isDebouncing && !query.isError && items.length > 0 ? (
              <CommandGroup>
                {items.map((ingredient) => {
                  const allergens = allergenList(ingredient);
                  const hoverText = ingredientHoverText(ingredient);
                  return (
                    <CommandItem
                      key={ingredient.id}
                      value={ingredient.id}
                      onSelect={() => chooseIngredient(ingredient)}
                      title={hoverText}
                      className="min-h-[58px] px-3 py-2"
                    >
                      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:grid-cols-[110px_minmax(180px,1.5fr)_120px_60px_95px_100px_100px]">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-slate-700 md:text-sm" title={getItemCode(ingredient)}><HighlightedText value={getItemCode(ingredient)} query={visibleSearch} /></div>
                          <div className="truncate text-sm font-medium text-slate-900 md:hidden" title={ingredient.name || '—'}><HighlightedText value={ingredient.name || '—'} query={visibleSearch} /></div>
                        </div>
                        <span className="hidden truncate font-medium text-slate-900 md:block" title={ingredient.name || '—'}><HighlightedText value={ingredient.name || '—'} query={visibleSearch} /></span>
                        <span className="hidden truncate text-xs text-slate-600 md:block" title={ingredient.category || '—'}><HighlightedText value={ingredient.category || '—'} query={visibleSearch} /></span>
                        <span className="hidden text-xs text-slate-600 md:block">{ingredient.unit || '—'}</span>
                        <span className={cn('hidden text-xs font-medium md:block', Number(ingredient.current_stock) <= 0 ? 'text-red-600' : 'text-slate-700')}>
                          {formatNumber(ingredient.current_stock || 0, 2)} {ingredient.stock_unit || ingredient.unit || ''}
                        </span>
                        <span className="hidden text-xs text-slate-700 md:block">
                          {ingredient.last_cost === null || typeof ingredient.last_cost === 'undefined' ? '—' : formatCurrency(ingredient.last_cost)}
                        </span>
                        <span className="justify-self-end md:justify-self-start">
                          {allergens.length ? (
                            <Badge variant="outline" className="max-w-[96px] border-amber-300 bg-amber-50 px-1.5 text-[10px] text-amber-800">
                              <ShieldAlert className="mr-1 h-3 w-3" />{allergens[0]}{allergens.length > 1 ? ` +${allergens.length - 1}` : ''}
                            </Badge>
                          ) : <span className="text-xs text-slate-400">—</span>}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>

          {!query.isFetching && !query.isError && totalCount > items.length && !viewAll ? (
            <button
              type="button"
              className="flex w-full items-center justify-between border-t px-3 py-2.5 text-left text-sm font-medium text-teal-700 hover:bg-teal-50"
              onClick={() => setViewAll(true)}
            >
              <span>View all {formatNumber(totalCount)} results{visibleSearch ? ` for “${visibleSearch}”` : ''}</span>
              <Search className="h-4 w-4" />
            </button>
          ) : null}

          {viewAll && totalPages > 1 ? (
            <div className="flex items-center justify-between border-t px-3 py-2">
              <Button type="button" size="sm" variant="outline" disabled={page <= 1 || query.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
              <span className="text-xs text-slate-500">Page {page} of {totalPages}</span>
              <Button type="button" size="sm" variant="outline" disabled={page >= totalPages || query.isFetching} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
