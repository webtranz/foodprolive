import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Plus, 
  Building2, 
  FileText, 
  Package,
  Star,
  Phone,
  Mail,
  MapPin
} from 'lucide-react';
import { format } from 'date-fns';

const STATUS_COLORS = {
  active: 'bg-green-600',
  inactive: 'bg-slate-400',
  draft: 'bg-slate-500',
  sent: 'bg-blue-500',
  confirmed: 'bg-green-600',
  delivered: 'bg-emerald-600',
  cancelled: 'bg-red-600'
};

export default function SupplierPortal() {
  const [activeTab, setActiveTab] = useState('suppliers');
  const [showSupplierDialog, setShowSupplierDialog] = useState(false);
  const [showRFQDialog, setShowRFQDialog] = useState(false);
  const [showPODialog, setShowPODialog] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);

  const [supplierForm, setSupplierForm] = useState({
    name: '',
    contact_person: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: '',
    payment_terms: '',
    categories: []
  });

  const queryClient = useQueryClient();

  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => base44.entities.Supplier.list()
  });

  const { data: purchaseOrders = [] } = useQuery({
    queryKey: ['purchaseOrders'],
    queryFn: () => base44.entities.PurchaseOrder.list('-order_date', 100)
  });

  const { data: rfqs = [] } = useQuery({
    queryKey: ['rfqs'],
    queryFn: () => base44.entities.RFQ.list('-issue_date', 100)
  });

  const createSupplierMutation = useMutation({
    mutationFn: (data) => base44.entities.Supplier.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      setShowSupplierDialog(false);
      resetSupplierForm();
    }
  });

  const updateSupplierMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Supplier.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      setShowSupplierDialog(false);
      setEditingSupplier(null);
      resetSupplierForm();
    }
  });

  const resetSupplierForm = () => {
    setSupplierForm({
      name: '',
      contact_person: '',
      email: '',
      phone: '',
      address: '',
      city: '',
      country: '',
      payment_terms: '',
      categories: []
    });
  };

  const handleSupplierSubmit = () => {
    if (editingSupplier) {
      updateSupplierMutation.mutate({ id: editingSupplier.id, data: supplierForm });
    } else {
      createSupplierMutation.mutate({ ...supplierForm, is_active: true, rating: 0 });
    }
  };

  const editSupplier = (supplier) => {
    setEditingSupplier(supplier);
    setSupplierForm({
      name: supplier.name || '',
      contact_person: supplier.contact_person || '',
      email: supplier.email || '',
      phone: supplier.phone || '',
      address: supplier.address || '',
      city: supplier.city || '',
      country: supplier.country || '',
      payment_terms: supplier.payment_terms || '',
      categories: supplier.categories || []
    });
    setShowSupplierDialog(true);
  };

  const topSuppliers = suppliers
    .filter(s => s.is_active)
    .sort((a, b) => (b.total_value || 0) - (a.total_value || 0))
    .slice(0, 5);

  const stats = {
    totalSuppliers: suppliers.filter(s => s.is_active).length,
    totalPOs: purchaseOrders.length,
    totalRFQs: rfqs.filter(r => r.status === 'open').length,
    avgDeliveryRate: suppliers.length > 0
      ? suppliers.reduce((sum, s) => sum + (s.on_time_delivery_rate || 0), 0) / suppliers.length
      : 0
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Supplier Portal" 
          description="Manage suppliers, RFQs, and purchase orders"
        >
          <Button onClick={() => { setEditingSupplier(null); resetSupplierForm(); setShowSupplierDialog(true); }} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" />
            Add Supplier
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Active Suppliers</p>
                  <p className="text-2xl font-bold text-slate-900">{stats.totalSuppliers}</p>
                </div>
                <Building2 className="w-8 h-8 text-indigo-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Purchase Orders</p>
                  <p className="text-2xl font-bold text-slate-900">{stats.totalPOs}</p>
                </div>
                <Package className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Open RFQs</p>
                  <p className="text-2xl font-bold text-slate-900">{stats.totalRFQs}</p>
                </div>
                <FileText className="w-8 h-8 text-amber-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Avg Delivery Rate</p>
                  <p className="text-2xl font-bold text-slate-900">{stats.avgDeliveryRate.toFixed(0)}%</p>
                </div>
                <Star className="w-8 h-8 text-blue-600" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
            <TabsTrigger value="rfqs">RFQs</TabsTrigger>
            <TabsTrigger value="orders">Purchase Orders</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>

          {/* Suppliers Tab */}
          <TabsContent value="suppliers" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {suppliers.map(supplier => (
                <Card key={supplier.id} className="hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg">{supplier.name}</CardTitle>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge className={supplier.is_active ? 'bg-green-600' : 'bg-slate-400'}>
                            {supplier.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                          {supplier.rating > 0 && (
                            <div className="flex items-center gap-1">
                              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                              <span className="text-sm">{supplier.rating.toFixed(1)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => editSupplier(supplier)}>
                        Edit
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {supplier.contact_person && (
                      <p className="text-sm text-slate-600">{supplier.contact_person}</p>
                    )}
                    {supplier.email && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Mail className="w-3 h-3" />
                        <span>{supplier.email}</span>
                      </div>
                    )}
                    {supplier.phone && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Phone className="w-3 h-3" />
                        <span>{supplier.phone}</span>
                      </div>
                    )}
                    {(supplier.city || supplier.country) && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <MapPin className="w-3 h-3" />
                        <span>{[supplier.city, supplier.country].filter(Boolean).join(', ')}</span>
                      </div>
                    )}
                    {supplier.total_orders > 0 && (
                      <div className="pt-2 border-t text-xs text-slate-500">
                        {supplier.total_orders} orders • ${supplier.total_value?.toFixed(0) || 0}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* RFQs Tab */}
          <TabsContent value="rfqs">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Request for Quotations</CardTitle>
                  <Button onClick={() => setShowRFQDialog(true)} size="sm">
                    <Plus className="w-4 h-4 mr-2" />
                    Create RFQ
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>RFQ Number</TableHead>
                      <TableHead>Issue Date</TableHead>
                      <TableHead>Deadline</TableHead>
                      <TableHead>Suppliers</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rfqs.map(rfq => (
                      <TableRow key={rfq.id}>
                        <TableCell className="font-medium">{rfq.rfq_number}</TableCell>
                        <TableCell>{format(new Date(rfq.issue_date), 'MMM d, yyyy')}</TableCell>
                        <TableCell>{format(new Date(rfq.response_deadline), 'MMM d, yyyy')}</TableCell>
                        <TableCell>{rfq.suppliers?.length || 0}</TableCell>
                        <TableCell>
                          <Badge className={STATUS_COLORS[rfq.status] || 'bg-slate-500'}>
                            {rfq.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {rfqs.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                          No RFQs created yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Purchase Orders Tab */}
          <TabsContent value="orders">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Purchase Orders</CardTitle>
                  <Button onClick={() => setShowPODialog(true)} size="sm">
                    <Plus className="w-4 h-4 mr-2" />
                    Create PO
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO Number</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Order Date</TableHead>
                      <TableHead>Delivery Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {purchaseOrders.map(po => (
                      <TableRow key={po.id}>
                        <TableCell className="font-medium">{po.po_number}</TableCell>
                        <TableCell>{po.supplier_name}</TableCell>
                        <TableCell>{format(new Date(po.order_date), 'MMM d, yyyy')}</TableCell>
                        <TableCell>
                          {po.expected_delivery_date ? format(new Date(po.expected_delivery_date), 'MMM d, yyyy') : '-'}
                        </TableCell>
                        <TableCell>${po.total_amount?.toFixed(2) || '0.00'}</TableCell>
                        <TableCell>
                          <Badge className={STATUS_COLORS[po.status] || 'bg-slate-500'}>
                            {po.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {purchaseOrders.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-slate-500 py-8">
                          No purchase orders created yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Performance Tab */}
          <TabsContent value="performance">
            <Card>
              <CardHeader>
                <CardTitle>Top Performing Suppliers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {topSuppliers.map((supplier, idx) => (
                    <div key={supplier.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                      <div className="flex items-center gap-4">
                        <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold">
                          {idx + 1}
                        </div>
                        <div>
                          <p className="font-medium">{supplier.name}</p>
                          <p className="text-sm text-slate-600">
                            {supplier.total_orders || 0} orders • {supplier.on_time_delivery_rate || 0}% on-time
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold">${supplier.total_value?.toFixed(0) || 0}</p>
                        {supplier.rating > 0 && (
                          <div className="flex items-center gap-1 justify-end">
                            <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                            <span className="text-sm">{supplier.rating.toFixed(1)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Supplier Dialog */}
        <Dialog open={showSupplierDialog} onOpenChange={setShowSupplierDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingSupplier ? 'Edit Supplier' : 'Add New Supplier'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Company Name *</Label>
                  <Input
                    value={supplierForm.name}
                    onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })}
                    placeholder="Supplier name"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Contact Person</Label>
                  <Input
                    value={supplierForm.contact_person}
                    onChange={(e) => setSupplierForm({ ...supplierForm, contact_person: e.target.value })}
                    placeholder="Contact name"
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Email *</Label>
                  <Input
                    type="email"
                    value={supplierForm.email}
                    onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })}
                    placeholder="email@example.com"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input
                    value={supplierForm.phone}
                    onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                    placeholder="Phone number"
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label>Address</Label>
                <Input
                  value={supplierForm.address}
                  onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })}
                  placeholder="Street address"
                  className="mt-1"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>City</Label>
                  <Input
                    value={supplierForm.city}
                    onChange={(e) => setSupplierForm({ ...supplierForm, city: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Country</Label>
                  <Input
                    value={supplierForm.country}
                    onChange={(e) => setSupplierForm({ ...supplierForm, country: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label>Payment Terms</Label>
                <Input
                  value={supplierForm.payment_terms}
                  onChange={(e) => setSupplierForm({ ...supplierForm, payment_terms: e.target.value })}
                  placeholder="e.g., Net 30, Net 60"
                  className="mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowSupplierDialog(false); setEditingSupplier(null); }}>
                Cancel
              </Button>
              <Button 
                onClick={handleSupplierSubmit}
                disabled={!supplierForm.name || !supplierForm.email || createSupplierMutation.isPending || updateSupplierMutation.isPending}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                {editingSupplier ? 'Update' : 'Create'} Supplier
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
