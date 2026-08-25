import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PlusCircle, MinusCircle, SlidersHorizontal } from 'lucide-react';
import { getItemCode } from '../../../shared/itemCode.js';
import { format } from 'date-fns';
import { getInventoryQuantities } from '@/lib/inventoryAvailability';

export default function InventoryTransactionDialog({ 
  open, 
  onOpenChange, 
  inventoryItem,
  transactionType = 'addition' 
}) {
  const [formData, setFormData] = useState({
    quantity: '',
    notes: '',
    transaction_date: format(new Date(), 'yyyy-MM-dd'),
    stock_date: format(new Date(), 'yyyy-MM-dd'),
    reason_code: '',
    unit_cost: '',
    batch_number: '',
    expiry_date: ''
  });

  const queryClient = useQueryClient();

  const transactionMutation = useMutation({
    mutationFn: async (data) => {
      if (data.transaction_type === 'addition') {
        return base44.inventory.receive({
          site_id: inventoryItem.site_id,
          site_name: inventoryItem.site_name,
          ingredient_id: inventoryItem.ingredient_id,
          ingredient_name: inventoryItem.ingredient_name,
          quantity: data.quantity,
          unit: inventoryItem.unit,
          unit_cost: data.unit_cost,
          batch_number: data.batch_number,
          expiry_date: data.expiry_date || null,
          stock_date: data.stock_date || data.transaction_date,
          received_date: data.stock_date || data.transaction_date,
          transaction_date: data.transaction_date,
          reference_id: inventoryItem.id,
          reference_type: 'manual',
          notes: data.notes,
          reason_code: data.reason_code || 'manual_receipt'
        });
      }

      return base44.inventory.adjust({
        inventory_id: inventoryItem.id,
        quantity_change: data.transaction_type === 'issuance'
          ? Math.abs(data.quantity) * -1
          : data.quantity,
        reason_code: data.reason_code || (data.transaction_type === 'issuance' ? 'manual_issue' : 'manual_adjustment'),
        notes: data.notes,
        transaction_date: data.transaction_date
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      onOpenChange(false);
      setFormData({
        quantity: '',
        notes: '',
        transaction_date: format(new Date(), 'yyyy-MM-dd'),
        stock_date: format(new Date(), 'yyyy-MM-dd'),
        reason_code: '',
        unit_cost: '',
        batch_number: '',
        expiry_date: ''
      });
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    const quantity = parseFloat(formData.quantity);
    if (!quantity || quantity <= 0) return;

    transactionMutation.mutate({
      transaction_type: transactionType,
      quantity,
      transaction_date: formData.transaction_date,
      stock_date: formData.stock_date,
      notes: formData.notes,
      reason_code: formData.reason_code,
      unit_cost: parseFloat(formData.unit_cost) || 0,
      batch_number: formData.batch_number,
      expiry_date: formData.expiry_date || null
    });
  };

  const isAddition = transactionType === 'addition';
  const stockQuantities = getInventoryQuantities(inventoryItem);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isAddition ? (
              <>
                <PlusCircle className="w-5 h-5 text-green-600" />
                Add Stock — {getItemCode(inventoryItem)} · {inventoryItem?.ingredient_name || '—'}
              </>
            ) : transactionType === 'adjustment' ? (
              <>
                <SlidersHorizontal className="w-5 h-5 text-blue-600" />
                Adjust Stock — {getItemCode(inventoryItem)} · {inventoryItem?.ingredient_name || '—'}
              </>
            ) : (
              <>
                <MinusCircle className="w-5 h-5 text-red-600" />
                Issue Stock — {getItemCode(inventoryItem)} · {inventoryItem?.ingredient_name || '—'}
              </>
            )}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-slate-50 rounded-lg p-3 text-sm">
            <p><span className="font-medium">Site:</span> {inventoryItem?.site_name}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <p><span className="block font-medium text-slate-500">On Hand</span>{stockQuantities.on_hand_quantity} {inventoryItem?.unit}</p>
              <p><span className="block font-medium text-violet-600">Reserved</span>{stockQuantities.reserved_quantity} {inventoryItem?.unit}</p>
              <p><span className="block font-medium text-cyan-700">Available</span>{stockQuantities.available_quantity} {inventoryItem?.unit}</p>
            </div>
          </div>

          <div>
            <Label>Quantity *</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              max={transactionType === 'issuance' ? stockQuantities.available_quantity : undefined}
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
              placeholder={`Amount to ${isAddition ? 'add' : transactionType === 'adjustment' ? 'adjust' : 'issue'} (${inventoryItem?.unit})`}
              className="mt-1"
              required
            />
          </div>

          {isAddition ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label>Unit Cost</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.unit_cost}
                  onChange={(e) => setFormData({ ...formData, unit_cost: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Batch / Lot</Label>
                <Input
                  value={formData.batch_number}
                  onChange={(e) => setFormData({ ...formData, batch_number: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Expiry Date</Label>
                <Input
                  type="date"
                  value={formData.expiry_date}
                  onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Stock Date *</Label>
                <Input
                  type="date"
                  value={formData.stock_date}
                  onChange={(e) => setFormData({ ...formData, stock_date: e.target.value })}
                  className="mt-1"
                  required
                />
                <p className="mt-1 text-xs text-slate-500">Date this batch became available in stock.</p>
              </div>
            </div>
          ) : null}

          <div>
            <Label>Date *</Label>
            <Input
              type="date"
              value={formData.transaction_date}
              onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
              className="mt-1"
              required
            />
          </div>

          <div>
            <Label>Reason Code</Label>
            <Input
              value={formData.reason_code}
              onChange={(e) => setFormData({ ...formData, reason_code: e.target.value })}
              placeholder={isAddition ? 'manual_receipt' : 'manual_issue'}
              className="mt-1"
            />
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Reason for transaction, supplier info, etc."
              className="mt-1"
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              type="submit"
              className={isAddition ? 'bg-green-600 hover:bg-green-700' : transactionType === 'adjustment' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'}
              disabled={transactionMutation.isPending}
            >
              {transactionMutation.isPending ? 'Processing...' : `${isAddition ? 'Add' : transactionType === 'adjustment' ? 'Adjust' : 'Issue'} Stock`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
