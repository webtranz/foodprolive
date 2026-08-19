import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Package, TrendingDown, ExternalLink, Clock3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { getItemCode } from '../../../shared/itemCode.js';

export default function InventoryAlerts({ inventory = [], upcomingNeeds = [] }) {
  const lowStockAlerts = inventory.filter(item => 
    item.status === 'low_stock' || item.status === 'out_of_stock'
  ).sort((a, b) => {
    if (a.status === 'out_of_stock' && b.status !== 'out_of_stock') return -1;
    if (a.status !== 'out_of_stock' && b.status === 'out_of_stock') return 1;
    return (a.quantity || 0) - (b.quantity || 0);
  });

  const shortageAlerts = upcomingNeeds.filter(need => {
    const inventoryItem = inventory.find(
      i => i.ingredient_id === need.ingredient_id && i.site_id === need.site_id
    );
    const available = inventoryItem?.quantity || 0;
    return available < need.required_quantity;
  });

  const expiryAlerts = inventory
    .filter((item) => (item.expired_lot_count || 0) > 0 || (item.near_expiry_count || 0) > 0)
    .sort((left, right) => ((right.expired_lot_count || 0) + (right.near_expiry_count || 0)) - ((left.expired_lot_count || 0) + (left.near_expiry_count || 0)));

  if (lowStockAlerts.length === 0 && shortageAlerts.length === 0 && expiryAlerts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Package className="w-5 h-5 text-green-600" />
            Inventory Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <Package className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm font-medium text-slate-700">All Stock Levels Normal</p>
            <p className="text-xs text-slate-500 mt-1">No alerts at this time</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
          Inventory Alerts
          <Badge variant="outline" className="ml-auto">
            {lowStockAlerts.length + shortageAlerts.length + expiryAlerts.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Low Stock Alerts */}
        {lowStockAlerts.slice(0, 5).map(item => (
          <div 
            key={item.id}
            className="flex items-start justify-between p-3 bg-amber-50 rounded-lg border border-amber-100"
          >
            <div className="flex-1">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{getItemCode(item)}</p>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{item.ingredient_name}</span>
                <Badge 
                  className={item.status === 'out_of_stock' 
                    ? 'bg-red-100 text-red-700' 
                    : 'bg-amber-100 text-amber-700'}
                >
                  {item.status === 'out_of_stock' ? 'Out of Stock' : 'Low Stock'}
                </Badge>
              </div>
              <p className="text-xs text-slate-600 mt-1">
                {item.site_name} • Current: {item.quantity} {item.unit} • Min: {item.min_stock_level || 0} {item.unit}
              </p>
            </div>
            <TrendingDown className="w-4 h-4 text-amber-600 flex-shrink-0" />
          </div>
        ))}

        {expiryAlerts.slice(0, 4).map((item) => (
          <div
            key={`${item.id}-expiry`}
            className="flex items-start justify-between p-3 bg-rose-50 rounded-lg border border-rose-100"
          >
            <div className="flex-1">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{getItemCode(item)}</p>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{item.ingredient_name}</span>
                {(item.expired_lot_count || 0) > 0 ? (
                  <Badge className="bg-rose-100 text-rose-700">Expired Lots</Badge>
                ) : (
                  <Badge className="bg-orange-100 text-orange-700">Near Expiry</Badge>
                )}
              </div>
              <p className="text-xs text-slate-600 mt-1">
                {item.site_name} • Expired: {item.expired_lot_count || 0} • Near expiry: {item.near_expiry_count || 0}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Next expiry: {item.next_expiry_date || 'Not set'}
              </p>
            </div>
            <Clock3 className="w-4 h-4 text-rose-600 flex-shrink-0" />
          </div>
        ))}

        {/* Upcoming Shortage Alerts */}
        {shortageAlerts.slice(0, 3).map((need, idx) => {
          const inventoryItem = inventory.find(
            i => i.ingredient_id === need.ingredient_id && i.site_id === need.site_id
          );
          const available = inventoryItem?.quantity || 0;
          const shortage = need.required_quantity - available;

          return (
            <div 
              key={idx}
              className="flex items-start justify-between p-3 bg-red-50 rounded-lg border border-red-100"
            >
              <div className="flex-1">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{getItemCode(need)}</p>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{need.ingredient_name}</span>
                  <Badge className="bg-red-100 text-red-700">Shortage Expected</Badge>
                </div>
                <p className="text-xs text-slate-600 mt-1">
                  {need.site_name} • Needed: {need.required_quantity} {need.unit} • Short: {shortage.toFixed(1)} {need.unit}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">For: {need.production_date}</p>
              </div>
              <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
            </div>
          );
        })}

        <Link to={createPageUrl('Inventory')}>
          <Button variant="outline" size="sm" className="w-full mt-2">
            <ExternalLink className="w-3 h-3 mr-2" />
            View All Inventory
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
