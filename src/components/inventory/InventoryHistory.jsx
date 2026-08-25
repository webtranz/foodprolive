import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowUpCircle, ArrowDownCircle, Activity, Repeat } from 'lucide-react';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/currency';

const TYPE_CONFIG = {
  addition: { icon: ArrowUpCircle, color: 'text-green-600', bg: 'bg-green-50' },
  receipt: { icon: ArrowUpCircle, color: 'text-green-600', bg: 'bg-green-50' },
  issuance: { icon: ArrowDownCircle, color: 'text-red-600', bg: 'bg-red-50' },
  production_use: { icon: ArrowDownCircle, color: 'text-orange-600', bg: 'bg-orange-50' },
  production_commitment: { icon: ArrowDownCircle, color: 'text-orange-600', bg: 'bg-orange-50' },
  production_return: { icon: ArrowUpCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  production_release: { icon: ArrowUpCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  opening_balance: { icon: ArrowUpCircle, color: 'text-green-600', bg: 'bg-green-50' },
  adjustment: { icon: Activity, color: 'text-blue-600', bg: 'bg-blue-50' },
  waste: { icon: ArrowDownCircle, color: 'text-purple-600', bg: 'bg-purple-50' },
  transfer_in: { icon: Repeat, color: 'text-sky-600', bg: 'bg-sky-50' },
  transfer_out: { icon: Repeat, color: 'text-sky-600', bg: 'bg-sky-50' },
  pos_sale: { icon: ArrowDownCircle, color: 'text-rose-600', bg: 'bg-rose-50' },
  return: { icon: ArrowUpCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  cancellation_return: { icon: ArrowUpCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  stock_correction: { icon: Activity, color: 'text-indigo-600', bg: 'bg-indigo-50' },
  d365_receipt: { icon: ArrowUpCircle, color: 'text-cyan-600', bg: 'bg-cyan-50' },
  d365_snapshot_adjustment: { icon: Activity, color: 'text-cyan-600', bg: 'bg-cyan-50' }
};

function formatQuantity(value, unit = '') {
  if (value === null || typeof value === 'undefined' || value === '') return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
}

function safeFormatDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : format(parsed, 'MMM d, yyyy');
}

function stockDateOf(transaction) {
  return transaction.stock_date || transaction.received_date || transaction.receipt_date || '-';
}

function movementLayersOf(transaction) {
  return Array.isArray(transaction?.movement_layers)
    ? transaction.movement_layers.filter((layer) => Number(layer?.quantity || 0) > 0)
    : [];
}

function layerValues(transaction, field, fallback) {
  const values = movementLayersOf(transaction)
    .map((layer) => layer?.[field])
    .filter(Boolean);
  return [...new Set(values)].length > 0 ? [...new Set(values)] : [fallback || '-'];
}

function sourceOf(transaction) {
  return transaction.source_label || transaction.source || transaction.movement_source || transaction.reference_type || transaction.reason_code || transaction.transaction_type || '-';
}

function movementTypeLabel(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'production_use') return 'Production start consumption';
  if (type === 'production_commitment') return 'Legacy approval consumption';
  if (['production_release', 'production_return'].includes(type)) return 'Production stock return';
  return type.replace(/_/g, ' ');
}

function referenceOf(transaction) {
  return transaction.reference_name || transaction.reference_number || transaction.reference_id || transaction.external_reference || '-';
}

function openingOf(transaction) {
  return transaction.opening_quantity ?? transaction.quantity_before ?? transaction.opening_balance;
}

function closingOf(transaction) {
  return transaction.closing_quantity ?? transaction.quantity_after ?? transaction.running_balance ?? transaction.closing_balance;
}

function additionOf(transaction) {
  if (transaction.addition_quantity !== null && typeof transaction.addition_quantity !== 'undefined') return Number(transaction.addition_quantity);
  return Number(transaction.quantity || 0) > 0 ? Number(transaction.quantity) : 0;
}

function consumptionOf(transaction) {
  if (transaction.consumption_quantity !== null && typeof transaction.consumption_quantity !== 'undefined') return Math.abs(Number(transaction.consumption_quantity));
  return Number(transaction.quantity || 0) < 0 ? Math.abs(Number(transaction.quantity)) : 0;
}

export default function InventoryHistory({ ingredientId, siteId }) {
  const queryClient = useQueryClient();
  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['inventoryTransactions', ingredientId, siteId],
    queryFn: () => base44.inventory.getMovements({
      ingredient_id: ingredientId,
      site_id: siteId
    })
  });

  useEffect(() => {
    const unsubscribe = base44.entities.InventoryTransaction?.subscribe?.(() => {
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions', ingredientId, siteId] });
    });
    return () => unsubscribe?.();
  }, [ingredientId, queryClient, siteId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Transaction History</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}
          </div>
        ) : transactions.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">No transactions yet</p>
        ) : (
          <div className="overflow-x-auto">
          <Table className="min-w-[1450px]">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Stock Date</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Opening</TableHead>
                <TableHead>Addition</TableHead>
                <TableHead>Consumption</TableHead>
                <TableHead>Closing</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map(transaction => {
                const config = TYPE_CONFIG[transaction.transaction_type] || TYPE_CONFIG.adjustment;
                const Icon = config.icon;
                
                return (
                  <TableRow key={transaction.id}>
                    <TableCell className="text-sm">
                      {safeFormatDate(transaction.transaction_date)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={config.bg}>
                        <Icon className={`w-3 h-3 mr-1 ${config.color}`} />
                        {String(sourceOf(transaction)).replace(/_/g, ' ')}
                      </Badge>
                      <p className="mt-1 text-xs capitalize text-slate-500">{movementTypeLabel(transaction.transaction_type)}</p>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {movementLayersOf(transaction).length > 0 ? (
                        <div className="space-y-1">
                          {movementLayersOf(transaction).map((layer, index) => (
                            <p key={`${layer.inventory_lot_id || layer.batch_number || 'lot'}-${index}`} className="whitespace-nowrap">
                              <span className="font-medium text-slate-800">{layer.batch_number || 'Unnumbered batch'}</span>
                              {' · '}{formatQuantity(layer.quantity, transaction.unit)}
                            </p>
                          ))}
                        </div>
                      ) : transaction.batch_number || '-'}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {layerValues(transaction, 'stock_date', stockDateOf(transaction)).map((value) => <p key={value}>{value}</p>)}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {layerValues(transaction, 'expiry_date', transaction.expiry_date || '-').map((value) => <p key={value}>{value}</p>)}
                    </TableCell>
                    <TableCell className="text-sm">{formatQuantity(openingOf(transaction), transaction.unit)}</TableCell>
                    <TableCell className="font-medium text-green-700">
                      {additionOf(transaction) > 0 ? `+${formatQuantity(additionOf(transaction), transaction.unit)}` : '-'}
                    </TableCell>
                    <TableCell className="font-medium text-red-700">
                      {consumptionOf(transaction) > 0 ? `-${formatQuantity(consumptionOf(transaction), transaction.unit)}` : '-'}
                    </TableCell>
                    <TableCell className="font-medium">{formatQuantity(closingOf(transaction), transaction.unit)}</TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {typeof transaction.total_cost === 'number'
                        ? formatCurrency(transaction.total_cost)
                        : '-'}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate text-sm text-slate-600">{referenceOf(transaction)}</TableCell>
                    <TableCell className="text-sm text-slate-600 max-w-xs truncate">
                      <p>{transaction.notes || transaction.reason_code || '-'}</p>
                      {(transaction.performed_by_name || transaction.user_name || transaction.created_by_name) ? (
                        <p className="mt-1 text-xs text-slate-400">By {transaction.performed_by_name || transaction.user_name || transaction.created_by_name}</p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
