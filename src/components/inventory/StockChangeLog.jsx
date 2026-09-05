import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, History, Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCSV } from '@/components/utils/exportData';
import { formatCurrency } from '@/lib/currency';
import { getItemCodeFromRecords } from '../../../shared/itemCode.js';
import { SOURCE_NAME_OPTIONS, normalizeSourceName } from '../../../shared/sourceNames.js';

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 3
  });
}

function formatDisplayDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function movementSource(record) {
  return record?.source_label || record?.source || record?.movement_source || record?.reference_type || record?.reason_code || record?.transaction_type || '-';
}

function movementTypeLabel(record) {
  const type = String(record?.transaction_type || '').trim().toLowerCase();
  if (type === 'production_use') return 'Production consumption';
  if (type === 'production_release') return 'Production release';
  if (type === 'production_return') return 'Production return';
  if (type === 'adjustment') return 'Stock adjustment';
  if (type === 'receipt') return 'Stock receipt';
  return type ? type.replace(/_/g, ' ') : '-';
}

function signedQuantity(record) {
  const quantity = Number(record?.quantity || 0);
  if (record?.addition_quantity !== null && typeof record?.addition_quantity !== 'undefined') {
    return Math.abs(Number(record.addition_quantity || 0));
  }
  if (record?.consumption_quantity !== null && typeof record?.consumption_quantity !== 'undefined') {
    return -Math.abs(Number(record.consumption_quantity || 0));
  }
  return quantity;
}

function getOpeningQuantity(record) {
  const value = record?.opening_quantity ?? record?.quantity_before ?? record?.opening_balance;
  return value === null || typeof value === 'undefined' ? null : Number(value);
}

function getClosingQuantity(record) {
  const value = record?.closing_quantity ?? record?.quantity_after ?? record?.running_balance ?? record?.closing_balance;
  return value === null || typeof value === 'undefined' ? null : Number(value);
}

function getReference(record) {
  return record?.reference_name || record?.reference_number || record?.reference_id || record?.external_reference || '-';
}

function getPostedDate(record) {
  return record?.created_date || record?.created_at || record?.updated_date || record?.transaction_date || '';
}

function mapMovement(record, ingredientById) {
  const itemCode = getItemCodeFromRecords([ingredientById.get(record?.ingredient_id), record]);
  const change = signedQuantity(record);
  return {
    ...record,
    item_code: itemCode,
    change_quantity: change,
    posted_date: getPostedDate(record),
    opening_quantity: getOpeningQuantity(record),
    closing_quantity: getClosingQuantity(record),
    source_label: movementSource(record),
    type_label: movementTypeLabel(record),
    reference_label: getReference(record)
  };
}

export default function StockChangeLog({
  title = 'Stock Change Log',
  description = 'Trace stock updates from uploads, manual receipts, production consumption, corrections, and transfers.',
  sites = [],
  ingredients = [],
  defaultSiteId = 'all',
  compact = false
}) {
  const [siteId, setSiteId] = useState(defaultSiteId || 'all');
  const [sourceName, setSourceName] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState(dateOffset(-30));
  const [dateTo, setDateTo] = useState(dateOffset(0));

  const ingredientById = useMemo(() => new Map(
    ingredients.map((ingredient) => [ingredient.id, ingredient])
  ), [ingredients]);

  const { data: movements = [], isLoading } = useQuery({
    queryKey: ['stock-change-log', siteId, dateFrom, dateTo],
    queryFn: () => base44.inventory.getMovements({
      site_id: siteId === 'all' ? '' : siteId,
      date_from: dateFrom,
      date_to: dateTo,
      limit: 1000
    })
  });

  const rows = useMemo(() => movements
    .map((record) => mapMovement(record, ingredientById))
    .filter((record) => {
      const searchText = `${record.item_code} ${record.ingredient_name} ${record.site_name} ${record.source_label} ${record.type_label} ${record.reason_code}`.toLowerCase();
      const matchesSearch = !search || searchText.includes(search.toLowerCase());
      const matchesSource = sourceName === 'all' || normalizeSourceName(record.source_name || record.source_label) === sourceName;
      return matchesSearch && matchesSource;
    }), [ingredientById, movements, search, sourceName]);

  const summary = useMemo(() => rows.reduce((acc, row) => {
    const change = Number(row.change_quantity || 0);
    if (change >= 0) acc.inbound += change;
    if (change < 0) acc.outbound += Math.abs(change);
    acc.value += Math.abs(Number(row.total_cost || 0));
    return acc;
  }, { inbound: 0, outbound: 0, value: 0 }), [rows]);

  const exportRows = () => downloadCSV(rows.map((row) => ({
    item_code: row.item_code,
    ingredient_name: row.ingredient_name,
    on_hand_stock: row.opening_quantity,
    addition: Number(row.change_quantity || 0) > 0 ? row.change_quantity : 0,
    consumption: Number(row.change_quantity || 0) < 0 ? Math.abs(Number(row.change_quantity || 0)) : 0,
    date_of_update: row.posted_date,
    total_now: row.closing_quantity,
    unit: row.unit,
  })), 'stock-change-log');

  return (
    <div className="space-y-4">
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b border-slate-100">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <History className="h-5 w-5 text-emerald-600" />
              {title}
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500">{description}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={exportRows} disabled={rows.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-5">
            <div className="md:col-span-2">
              <Label>Search</Label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Item, ingredient, location, reference"
                />
              </div>
            </div>
            <div>
              <Label>Location</Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Locations</SelectItem>
                  {sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Source Name</Label>
              <Select value={sourceName} onValueChange={setSourceName}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  {SOURCE_NAME_OPTIONS.map((source) => (
                    <SelectItem key={source} value={source}>{source}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2 md:col-span-1">
              <div>
                <Label>From</Label>
                <Input className="mt-1" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
              </div>
              <div>
                <Label>To</Label>
                <Input className="mt-1" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
              <p className="text-xs font-medium text-emerald-700">Stock Added</p>
              <p className="mt-1 text-xl font-semibold text-emerald-900">{formatQuantity(summary.inbound)}</p>
            </div>
            <div className="rounded-lg border border-rose-100 bg-rose-50 p-3">
              <p className="text-xs font-medium text-rose-700">Stock Removed</p>
              <p className="mt-1 text-xl font-semibold text-rose-900">{formatQuantity(summary.outbound)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs font-medium text-slate-500">Changes</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{rows.length}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs font-medium text-slate-500">Movement Value</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{formatCurrency(summary.value)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-sm">
        <CardContent className="overflow-x-auto p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-12 w-full" />)}
            </div>
          ) : (
            <Table className={compact ? 'min-w-[850px]' : 'min-w-[950px]'}>
              <TableHeader>
                <TableRow>
                  <TableHead>Item Code</TableHead>
                  <TableHead>Item Name</TableHead>
                  <TableHead>On Hand Stock</TableHead>
                  <TableHead>Addition</TableHead>
                  <TableHead>Consumption</TableHead>
                  <TableHead>Date of Update</TableHead>
                  <TableHead>Total Now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                      No stock changes found for the selected filters.
                    </TableCell>
                  </TableRow>
                ) : rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs text-slate-600">{row.item_code || '-'}</TableCell>
                    <TableCell className="font-medium">{row.ingredient_name || '-'}</TableCell>
                    <TableCell>{row.opening_quantity === null ? '-' : `${formatQuantity(row.opening_quantity)} ${row.unit || ''}`}</TableCell>
                    <TableCell className="font-semibold text-emerald-700">
                      {Number(row.change_quantity || 0) > 0 ? `+${formatQuantity(row.change_quantity)} ${row.unit || ''}` : '-'}
                    </TableCell>
                    <TableCell className="font-semibold text-rose-700">
                      {Number(row.change_quantity || 0) < 0 ? `-${formatQuantity(Math.abs(Number(row.change_quantity || 0)))} ${row.unit || ''}` : '-'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDisplayDate(row.posted_date)}</TableCell>
                    <TableCell className="font-semibold text-slate-900">{row.closing_quantity === null ? '-' : `${formatQuantity(row.closing_quantity)} ${row.unit || ''}`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
