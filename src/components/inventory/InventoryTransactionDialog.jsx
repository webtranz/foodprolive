import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PlusCircle, MinusCircle } from 'lucide-react';
import { format } from 'date-fns';

export default function InventoryTransactionDialog({ 
  open, 
  onOpenChange, 
  inventoryItem,
  transactionType = 'addition' 
}) {
  const [formData, setFormData] = useState({
    quantity: '',
    notes: '',
    transaction_date: format(new Date(), 'yyyy-MM-dd')
  });

  const queryClient = useQueryClient();

  const transactionMutation = useMutation({
    mutationFn: async (data) => {
      const user = await base44.auth.me();
      
      // Create transaction record
      await base44.entities.InventoryTransaction.create({
        site_id: inventoryItem.site_id,
        site_name: inventoryItem.site_name,
        ingredient_id: inventoryItem.ingredient_id,
        ingredient_name: inventoryItem.ingredient_name,
        transaction_type: data.transaction_type,
        quantity: data.quantity,
        unit: inventoryItem.unit,
        transaction_date: data.transaction_date,
        notes: data.notes,
        performed_by: user.email,
        reference_type: 'manual'
      });

      // Update inventory
      const newQuantity = data.transaction_type === 'addition' 
        ? (inventoryItem.quantity || 0) + Math.abs(data.quantity)
        : Math.max(0, (inventoryItem.quantity || 0) - Math.abs(data.quantity));

      let status = 'in_stock';
      if (newQuantity <= 0) status = 'out_of_stock';
      else if (newQuantity <= (inventoryItem.min_stock_level || 0)) status = 'low_stock';

      await base44.entities.Inventory.update(inventoryItem.id, {
        quantity: newQuantity,
        status,
        last_restocked: data.transaction_type === 'addition' ? data.transaction_date : inventoryItem.last_restocked
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryTransactions'] });
      onOpenChange(false);
      setFormData({
        quantity: '',
        notes: '',
        transaction_date: format(new Date(), 'yyyy-MM-dd')
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
      notes: formData.notes
    });
  };

  const isAddition = transactionType === 'addition';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isAddition ? (
              <>
                <PlusCircle className="w-5 h-5 text-green-600" />
                Add Stock - {inventoryItem?.ingredient_name}
              </>
            ) : (
              <>
                <MinusCircle className="w-5 h-5 text-red-600" />
                Issue Stock - {inventoryItem?.ingredient_name}
              </>
            )}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-slate-50 rounded-lg p-3 text-sm">
            <p><span className="font-medium">Site:</span> {inventoryItem?.site_name}</p>
            <p><span className="font-medium">Current Stock:</span> {inventoryItem?.quantity} {inventoryItem?.unit}</p>
          </div>

          <div>
            <Label>Quantity *</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
              placeholder={`Amount to ${isAddition ? 'add' : 'issue'} (${inventoryItem?.unit})`}
              className="mt-1"
              required
            />
          </div>

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
              className={isAddition ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
              disabled={transactionMutation.isPending}
            >
              {transactionMutation.isPending ? 'Processing...' : `${isAddition ? 'Add' : 'Issue'} Stock`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}