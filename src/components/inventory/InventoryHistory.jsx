import React from 'react';
import { useQuery } from '@tanstack/react-query';
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
  adjustment: { icon: Activity, color: 'text-blue-600', bg: 'bg-blue-50' },
  waste: { icon: ArrowDownCircle, color: 'text-purple-600', bg: 'bg-purple-50' },
  transfer_in: { icon: Repeat, color: 'text-sky-600', bg: 'bg-sky-50' },
  transfer_out: { icon: Repeat, color: 'text-sky-600', bg: 'bg-sky-50' },
  pos_sale: { icon: ArrowDownCircle, color: 'text-rose-600', bg: 'bg-rose-50' }
};

export default function InventoryHistory({ ingredientId, siteId }) {
  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['inventoryTransactions', ingredientId, siteId],
    queryFn: () => base44.inventory.getMovements({
      ingredient_id: ingredientId,
      site_id: siteId
    })
  });

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Value</TableHead>
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
                      {format(new Date(transaction.transaction_date), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={config.bg}>
                        <Icon className={`w-3 h-3 mr-1 ${config.color}`} />
                        {transaction.transaction_type.replace(/_/g, ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className={transaction.quantity > 0 ? 'text-green-600' : 'text-red-600'}>
                        {transaction.quantity > 0 ? '+' : ''}{transaction.quantity} {transaction.unit}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {transaction.batch_number || '-'}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {typeof transaction.total_cost === 'number'
                        ? formatCurrency(transaction.total_cost)
                        : '-'}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600 max-w-xs truncate">
                      {transaction.notes || transaction.reason_code || '-'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
