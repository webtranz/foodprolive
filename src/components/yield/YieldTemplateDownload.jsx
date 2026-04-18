import React from 'react';
import { Button } from '@/components/ui/button';
import { Download, FileSpreadsheet } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function YieldTemplateDownload({ onUpload }) {
  const downloadTemplate = (type) => {
    const templates = {
      ingredients: {
        headers: ['name', 'cuisine_type', 'category', 'unit', 'raw_weight_per_unit', 'cooked_weight_per_unit', 'cooking_yield_percent', 'shrinkage_percent', 'calories_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'cost_per_unit', 'supplier'],
        sample: [
          ['Chicken Breast', 'universal', 'proteins_poultry', 'kg', '1000', '750', '75', '25', '165', '31', '0', '3.6', '8', 'Local Supplier'],
          ['Basmati Rice', 'desi', 'grains_cereals', 'kg', '1000', '2100', '210', '0', '350', '7.5', '78', '0.5', '3.5', 'Rice Imports']
        ]
      },
      recipes: {
        headers: ['name', 'cuisine_type', 'category', 'description', 'servings', 'prep_time_minutes', 'cook_time_minutes', 'total_calories', 'calories_per_serving', 'protein_per_serving', 'carbs_per_serving', 'fat_per_serving', 'instructions'],
        sample: [
          ['Grilled Chicken', 'continental', 'main_course', 'Tender grilled chicken with herbs', '10', '15', '25', '1650', '165', '31', '0', '3.6', 'Marinate chicken. Grill on medium heat 12 min each side.'],
          ['Vegetable Biryani', 'desi', 'main_course', 'Aromatic rice dish with seasonal vegetables', '20', '30', '45', '7000', '350', '8', '70', '5', 'Cook rice separately. Saute vegetables with spices. Layer and dum cook 20 min.']
        ]
      },
      d365: {
        headers: ['d365_item_code', 'item_name', 'item_type', 'unit_of_measure', 'quantity', 'unit_price', 'total_amount', 'site_id', 'warehouse_id', 'purchase_requisition_ref', 'purchase_order_ref', 'vendor_account', 'delivery_date', 'cost_center', 'project_code', 'currency', 'notes'],
        sample: [
          ['FOOD-001', 'Chicken Breast', 'Item', 'kg', '100', '8.50', '850.00', 'SITE-001', 'WH-MAIN', 'PR-2026-001', 'PO-2026-001', 'VENDOR-001', '2026-03-10', 'CC-KITCHEN', 'PROJ-001', 'USD', 'Bulk purchase for weekly production'],
          ['FOOD-002', 'Basmati Rice', 'Item', 'kg', '200', '3.50', '700.00', 'SITE-001', 'WH-MAIN', 'PR-2026-002', 'PO-2026-002', 'VENDOR-002', '2026-03-10', 'CC-KITCHEN', 'PROJ-001', 'USD', 'Weekly rice stock'],
          ['FOOD-003', 'Olive Oil', 'Item', 'l', '50', '12.00', '600.00', 'SITE-002', 'WH-STORE', 'PR-2026-003', '', 'VENDOR-003', '2026-03-12', 'CC-KITCHEN', 'PROJ-002', 'USD', 'Monthly supply']
        ]
      },
      juice: {
        headers: ['product', 'total_weight_kg', 'total_juice_ltr', 'juice_per_kg_ml', 'extracted_percentage', 'wastage_percentage'],
        sample: [
          ['Lemon', '15.32', '5', '326', '32.6', '67.4'],
          ['Orange', '16.7', '8', '478', '47.9', '52.1'],
          ['Carrot', '11.65', '6', '515', '51.5', '48.5']
        ]
      },
      meat: {
        headers: ['product', 'cuisine_type', 'weight_before_defrosting_kg', 'weight_after_defrosting_kg', 'defrosting_loss_percent', 'trimming_percent', 'final_yield_percent'],
        sample: [
          ['Beef Chunks', 'continental', '6.56', '6.16', '6.09', '5', '88.9'],
          ['Beef Tenderloin', 'continental', '4.36', '3.99', '8.48', '5', '86.5'],
          ['Chicken Breast', 'universal', '5.93', '5.92', '0.17', '2', '97.8']
        ]
      },
      vegetables: {
        headers: ['product', 'cuisine_type', 'weight_before_peeling_kg', 'weight_after_peeling_kg', 'peeling_loss_percent', 'usable_yield_percent'],
        sample: [
          ['Lettuce', 'universal', '22.4', '21.4', '4.46', '95.5'],
          ['Beetroot', 'universal', '6.11', '4.5', '26.35', '73.6'],
          ['Carrot', 'universal', '13.54', '11.5', '15.07', '84.9']
        ]
      }
    };

    const template = templates[type];
    const csv = [
      template.headers.join(','),
      ...template.sample.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${type}_template.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      <Card className="hover:shadow-lg transition-shadow">
        <CardHeader>
          <FileSpreadsheet className="w-8 h-8 text-blue-600 mb-2" />
          <CardTitle className="text-lg">Ingredients Template</CardTitle>
          <CardDescription>Complete ingredient yield data with nutrition</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={() => downloadTemplate('ingredients')} 
            className="w-full"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </Button>
        </CardContent>
      </Card>

      <Card className="hover:shadow-lg transition-shadow border-purple-100">
        <CardHeader>
          <FileSpreadsheet className="w-8 h-8 text-purple-600 mb-2" />
          <CardTitle className="text-lg">Recipes Template</CardTitle>
          <CardDescription>Recipe details, servings, macros & instructions</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={() => downloadTemplate('recipes')} 
            className="w-full"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </Button>
        </CardContent>
      </Card>

      <Card className="hover:shadow-lg transition-shadow border-indigo-100">
        <CardHeader>
          <FileSpreadsheet className="w-8 h-8 text-indigo-600 mb-2" />
          <CardTitle className="text-lg">D365 Integration</CardTitle>
          <CardDescription>Purchase requisitions & PO data for Dynamics 365</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={() => downloadTemplate('d365')} 
            className="w-full"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </Button>
        </CardContent>
      </Card>

      <Card className="hover:shadow-lg transition-shadow">
        <CardHeader>
          <FileSpreadsheet className="w-8 h-8 text-orange-600 mb-2" />
          <CardTitle className="text-lg">Juice Extraction</CardTitle>
          <CardDescription>Fruits & vegetables juice yields</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={() => downloadTemplate('juice')} 
            className="w-full"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </Button>
        </CardContent>
      </Card>

      <Card className="hover:shadow-lg transition-shadow">
        <CardHeader>
          <FileSpreadsheet className="w-8 h-8 text-red-600 mb-2" />
          <CardTitle className="text-lg">Meat & Seafood</CardTitle>
          <CardDescription>Defrosting and trimming yields</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={() => downloadTemplate('meat')} 
            className="w-full"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </Button>
        </CardContent>
      </Card>

      <Card className="hover:shadow-lg transition-shadow">
        <CardHeader>
          <FileSpreadsheet className="w-8 h-8 text-green-600 mb-2" />
          <CardTitle className="text-lg">Vegetables</CardTitle>
          <CardDescription>Peeling and preparation yields</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={() => downloadTemplate('vegetables')} 
            className="w-full"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}