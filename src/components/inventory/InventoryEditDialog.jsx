import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Edit } from 'lucide-react';

export default function InventoryEditDialog({ open, onOpenChange, inventoryItem }) {
  const [formData, setFormData] = useState({
    min_stock_level: '',
    max_stock_level: '',
    expiry_date: '',
    valuation_method: 'fifo'
  });

  const queryClient = useQueryClient();

  useEffect(() => {
    if (inventoryItem) {
      setFormData({
        min_stock_level: inventoryItem.min_stock_level || '',
        max_stock_level: inventoryItem.max_stock_level || '',
        expiry_date: inventoryItem.expiry_date || '',
        valuation_method: inventoryItem.valuation_method || 'fifo'
      });
    }
  }, [inventoryItem]);

  const updateMutation = useMutation({
    mutationFn: (data) => base44.entities.Inventory.update(inventoryItem.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    updateMutation.mutate({
      min_stock_level: parseFloat(formData.min_stock_level) || null,
      max_stock_level: parseFloat(formData.max_stock_level) || null,
      expiry_date: formData.expiry_date || null,
      valuation_method: formData.valuation_method || 'fifo'
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit className="w-5 h-5" />
            Edit Inventory Settings
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-slate-50 rounded-lg p-3 text-sm">
            <p><span className="font-medium">{inventoryItem?.ingredient_name}</span></p>
            <p className="text-slate-600">{inventoryItem?.site_name}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Min Stock Level</Label>
              <Input
                type="number"
                step="0.1"
                value={formData.min_stock_level}
                onChange={(e) => setFormData({ ...formData, min_stock_level: e.target.value })}
                placeholder="Minimum level"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Max Stock Level</Label>
              <Input
                type="number"
                step="0.1"
                value={formData.max_stock_level}
                onChange={(e) => setFormData({ ...formData, max_stock_level: e.target.value })}
                placeholder="Maximum level"
                className="mt-1"
              />
            </div>
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
            <Label>Valuation Method</Label>
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
              value={formData.valuation_method}
              onChange={(e) => setFormData({ ...formData, valuation_method: e.target.value })}
            >
              <option value="fifo">FIFO</option>
              <option value="weighted_average">Weighted Average</option>
            </select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              type="submit"
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
