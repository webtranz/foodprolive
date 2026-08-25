import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/currency';
import IngredientSearchCombobox from '@/components/ingredients/IngredientSearchCombobox';
import { getItemCode } from '../../shared/itemCode.js';
import { normalizeSiteType, SITE_HIERARCHY_TYPES } from '../../shared/siteHierarchy.js';
import {
  AlertTriangle,
  Building2,
  ClipboardList,
  DollarSign,
  Plus,
  ShoppingCart,
  Truck
} from 'lucide-react';

const supplierFormTemplate = {
  name: '',
  contact_person: '',
  email: '',
  phone: '',
  address: '',
  city: '',
  country: '',
  payment_terms: '',
  lead_time_days: '0',
  status: 'active',
  rating: '0',
  categories: '',
  notes: ''
};

const requestItemTemplate = {
  ingredient_id: '',
  item_code: '',
  ingredient_name: '',
  requested_quantity: '',
  unit: '',
  estimated_unit_price: '',
  preferred_supplier_id: ''
};

const requestFormTemplate = {
  site_id: '',
  needed_by: '',
  priority: 'normal',
  notes: '',
  items: [{ ...requestItemTemplate }]
};

const orderFormTemplate = {
  request_id: '',
  supplier_id: '',
  expected_delivery_date: '',
  tax_amount: '0',
  notes: ''
};

const invoiceFormTemplate = {
  supplier_id: '',
  purchase_order_id: '',
  goods_receipt_id: '',
  invoice_number: '',
  invoice_date: new Date().toISOString().slice(0, 10),
  due_date: '',
  subtotal: '',
  tax_amount: '0',
  total_amount: '',
  notes: ''
};

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value || 0));
}

function statusBadgeClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (['approved', 'received', 'posted', 'active'].includes(normalized)) return 'bg-emerald-100 text-emerald-700';
  if (['partially_received', 'partially_accepted', 'pending'].includes(normalized)) return 'bg-amber-100 text-amber-700';
  if (['cancelled', 'rejected'].includes(normalized)) return 'bg-red-100 text-red-700';
  return 'bg-slate-100 text-slate-700';
}

function getActiveReceiptDestinationStores(order, sites = []) {
  if (!order?.site_id) return [];
  const sitesById = new Map(sites.map((site) => [String(site.id), site]));
  const orderSiteId = String(order.site_id);
  const isWithinOrderLocation = (site) => {
    let cursor = site;
    const visited = new Set();
    while (cursor) {
      const cursorId = String(cursor.id || '');
      if (!cursorId || visited.has(cursorId)) return false;
      if (cursorId === orderSiteId) return true;
      visited.add(cursorId);
      cursor = cursor.parent_site_id ? sitesById.get(String(cursor.parent_site_id)) : null;
    }
    return false;
  };

  return sites
    .filter((site) => (
      site.is_active !== false
      && normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE
      && isWithinOrderLocation(site)
    ))
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function KPI({ title, value, subtitle, icon: Icon, tone }) {
  return (
    <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-500">{title}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
            <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
          </div>
          <div className={`rounded-2xl p-3 ${tone}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProcurementModule() {
  const queryClient = useQueryClient();
  const { role, can } = usePermissions();
  const canManageProcurement = can('manage_procurement');
  const canApproveProcurement = can('approve_procurement');
  const canManageSuppliers = can('manage_suppliers');
  const canViewPerformance = canManageProcurement || canApproveProcurement;

  const [activeTab, setActiveTab] = useState('requests');
  const [supplierDialogOpen, setSupplierDialogOpen] = useState(false);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [supplierForm, setSupplierForm] = useState(supplierFormTemplate);
  const [requestForm, setRequestForm] = useState(requestFormTemplate);
  const [orderForm, setOrderForm] = useState(orderFormTemplate);
  const [receiptOrderId, setReceiptOrderId] = useState('');
  const [receiptDestinationStoreId, setReceiptDestinationStoreId] = useState('');
  const [receiptDate, setReceiptDate] = useState(new Date().toISOString().slice(0, 10));
  const [receiptNotes, setReceiptNotes] = useState('');
  const [receiptQuantities, setReceiptQuantities] = useState({});
  const [receiptRejectedQuantities, setReceiptRejectedQuantities] = useState({});
  const [receiptBatches, setReceiptBatches] = useState({});
  const [receiptExpiries, setReceiptExpiries] = useState({});
  const [invoiceForm, setInvoiceForm] = useState(invoiceFormTemplate);
  const [priceIngredientId, setPriceIngredientId] = useState('');
  const [priceIngredient, setPriceIngredient] = useState(null);

  const { data: suppliers = [] } = useQuery({
    queryKey: ['procurementSuppliers'],
    queryFn: () => base44.procurement.listSuppliers()
  });

  const { data: requests = [] } = useQuery({
    queryKey: ['procurementRequests'],
    queryFn: () => base44.procurement.listRequests()
  });

  const { data: materialRequests = [] } = useQuery({
    queryKey: ['materialRequestsWorkflow'],
    queryFn: () => base44.materialRequests.list(),
    enabled: can('view_material_request') || can('acknowledge_material_request') || can('manage_procurement') || can('approve_procurement')
  });

  const { data: orders = [] } = useQuery({
    queryKey: ['procurementOrders'],
    queryFn: () => base44.procurement.listOrders()
  });

  const { data: receipts = [] } = useQuery({
    queryKey: ['procurementReceipts'],
    queryFn: () => base44.procurement.listReceipts()
  });

  const { data: invoices = [] } = useQuery({
    queryKey: ['procurementInvoices'],
    queryFn: () => base44.procurement.listInvoices()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const resolveProcurementItemCode = (item) => getItemCode(item);

  const { data: inventory = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => base44.inventory.getStockOnHand()
  });

  const { data: performance = [] } = useQuery({
    queryKey: ['procurementPerformance'],
    queryFn: () => base44.procurement.getPerformance(),
    enabled: canViewPerformance
  });

  const { data: priceComparison = [] } = useQuery({
    queryKey: ['procurementPriceComparison', priceIngredientId],
    queryFn: () => base44.procurement.getPriceComparison({
      ingredient_id: priceIngredientId || undefined
    })
  });

  const refreshProcurement = () => {
    queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
    queryClient.invalidateQueries({ queryKey: ['procurementSuppliers'] });
    queryClient.invalidateQueries({ queryKey: ['procurementRequests'] });
    queryClient.invalidateQueries({ queryKey: ['procurementOrders'] });
    queryClient.invalidateQueries({ queryKey: ['procurementReceipts'] });
    queryClient.invalidateQueries({ queryKey: ['procurementInvoices'] });
    queryClient.invalidateQueries({ queryKey: ['procurementPerformance'] });
    queryClient.invalidateQueries({ queryKey: ['procurementPriceComparison'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };

  const visibleMaterialRequests = materialRequests.filter((request) =>
    String(request.status || '').toLowerCase() !== 'awaiting_production_approval'
  );

  const supplierMutation = useMutation({
    mutationFn: (payload) => {
      const body = {
        ...payload,
        lead_time_days: Number(payload.lead_time_days || 0),
        rating: Number(payload.rating || 0),
        categories: payload.categories
          ? payload.categories.split(',').map((entry) => entry.trim()).filter(Boolean)
          : []
      };
      if (editingSupplier) {
        return base44.procurement.updateSupplier(editingSupplier.id, body);
      }
      return base44.procurement.createSupplier(body);
    },
    onSuccess: () => {
      setSupplierDialogOpen(false);
      setEditingSupplier(null);
      setSupplierForm(supplierFormTemplate);
      refreshProcurement();
    }
  });

  const createRequestMutation = useMutation({
    mutationFn: (payload) => base44.procurement.createRequest(payload),
    onSuccess: () => {
      setRequestDialogOpen(false);
      setRequestForm(requestFormTemplate);
      refreshProcurement();
    }
  });

  const autoGenerateRequestMutation = useMutation({
    mutationFn: () => {
      const lowStockSite = sites[0];
      return base44.procurement.autoGenerateRequest({
        site_id: lowStockSite?.id || null,
        site_name: lowStockSite?.name || null
      });
    },
    onSuccess: () => refreshProcurement()
  });

  const approveRequestMutation = useMutation({
    mutationFn: ({ id, status }) => (
      status === 'approved'
        ? base44.procurement.approveRequest(id)
        : base44.procurement.rejectRequest(id)
    ),
    onSuccess: () => refreshProcurement()
  });

  const acknowledgeMaterialRequestMutation = useMutation({
    mutationFn: ({ id, notes }) => base44.materialRequests.acknowledge(id, { notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materialRequestsWorkflow'] });
      queryClient.invalidateQueries({ queryKey: ['productions'] });
    }
  });

  const createOrderMutation = useMutation({
    mutationFn: (payload) => base44.procurement.createOrder(payload),
    onSuccess: () => {
      setOrderDialogOpen(false);
      setOrderForm(orderFormTemplate);
      refreshProcurement();
    }
  });

  const updateOrderStatusMutation = useMutation({
    mutationFn: ({ id, type }) => (
      type === 'approve'
        ? base44.procurement.approveOrder(id)
        : base44.procurement.cancelOrder(id)
    ),
    onSuccess: () => refreshProcurement()
  });

  const createReceiptMutation = useMutation({
    mutationFn: (payload) => base44.procurement.createReceipt(payload),
    onSuccess: () => {
      setReceiptDialogOpen(false);
      setReceiptOrderId('');
      setReceiptDestinationStoreId('');
      setReceiptQuantities({});
      setReceiptRejectedQuantities({});
      setReceiptBatches({});
      setReceiptExpiries({});
      setReceiptNotes('');
      setReceiptDate(new Date().toISOString().slice(0, 10));
      refreshProcurement();
    }
  });

  const createInvoiceMutation = useMutation({
    mutationFn: (payload) => base44.procurement.createInvoice(payload),
    onSuccess: () => {
      setInvoiceDialogOpen(false);
      setInvoiceForm(invoiceFormTemplate);
      refreshProcurement();
    }
  });

  const lowStockItems = useMemo(() => (
    inventory.filter((item) => {
      const minimum = Number(item.min_stock_level || 0);
      const quantity = Number(item.quantity || 0);
      return ['low_stock', 'out_of_stock'].includes(String(item.status || '').toLowerCase()) || (minimum > 0 && quantity <= minimum);
    })
  ), [inventory]);

  const selectedOrderForReceipt = useMemo(
    () => orders.find((order) => order.id === receiptOrderId),
    [orders, receiptOrderId]
  );

  const receiptDestinationStores = useMemo(
    () => getActiveReceiptDestinationStores(selectedOrderForReceipt, sites),
    [selectedOrderForReceipt, sites]
  );

  const selectedOrderSite = useMemo(
    () => sites.find((site) => String(site.id) === String(selectedOrderForReceipt?.site_id || '')) || null,
    [selectedOrderForReceipt, sites]
  );

  const orderAlreadyTargetsStore = Boolean(
    selectedOrderSite
    && normalizeSiteType(selectedOrderSite.type) === SITE_HIERARCHY_TYPES.STORE
  );
  const effectiveReceiptDestinationStoreId = orderAlreadyTargetsStore
    ? (receiptDestinationStores[0]?.id || '')
    : receiptDestinationStoreId;

  const selectedRequestForOrder = useMemo(
    () => requests.find((request) => request.id === orderForm.request_id),
    [requests, orderForm.request_id]
  );

  const procurementStats = useMemo(() => ({
    supplierCount: suppliers.length,
    pendingMaterialRequests: materialRequests.filter((entry) => entry.status === 'pending_procurement_ack').length,
    pendingRequests: requests.filter((entry) => entry.status === 'pending').length,
    approvedOrders: orders.filter((entry) => entry.status === 'approved').length,
    receivedOrders: orders.filter((entry) => entry.status === 'received').length,
    pendingInvoices: invoices.filter((entry) => ['pending', 'draft'].includes(String(entry.status || '').toLowerCase())).length,
    lowStockCount: lowStockItems.length
  }), [suppliers.length, materialRequests, requests, orders, invoices, lowStockItems.length]);

  const openEditSupplier = (supplier) => {
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
      lead_time_days: String(supplier.lead_time_days || 0),
      status: supplier.status || 'active',
      rating: String(supplier.rating || 0),
      categories: Array.isArray(supplier.categories) ? supplier.categories.join(', ') : '',
      notes: supplier.notes || ''
    });
    setSupplierDialogOpen(true);
  };

  const submitRequest = () => {
    const site = sites.find((entry) => entry.id === requestForm.site_id);
    const items = requestForm.items.map((item) => {
      const supplier = suppliers.find((entry) => entry.id === item.preferred_supplier_id);
      return {
        ingredient_id: item.ingredient_id,
        item_code: getItemCode(item, ''),
        ingredient_name: item.ingredient_name || '',
        requested_quantity: Number(item.requested_quantity || 0),
        unit: item.unit || '',
        estimated_unit_price: Number(item.estimated_unit_price || 0),
        preferred_supplier_id: supplier?.id || null,
        preferred_supplier_name: supplier?.name || null
      };
    }).filter((item) => item.ingredient_name && item.requested_quantity > 0);

    createRequestMutation.mutate({
      site_id: requestForm.site_id || null,
      site_name: site?.name || null,
      request_date: new Date().toISOString().slice(0, 10),
      needed_by: requestForm.needed_by || null,
      priority: requestForm.priority,
      notes: requestForm.notes,
      items
    });
  };

  const submitOrder = () => {
    const site = sites.find((entry) => entry.id === selectedRequestForOrder?.site_id);
    createOrderMutation.mutate({
      request_id: orderForm.request_id,
      supplier_id: orderForm.supplier_id,
      site_id: site?.id || null,
      site_name: site?.name || selectedRequestForOrder?.site_name || null,
      order_date: new Date().toISOString().slice(0, 10),
      expected_delivery_date: orderForm.expected_delivery_date || null,
      tax_amount: Number(orderForm.tax_amount || 0),
      notes: orderForm.notes
    });
  };

  const submitReceipt = () => {
    if (!selectedOrderForReceipt) return;
    const items = selectedOrderForReceipt.items.map((item) => {
      const remaining = Math.max(0, Number(item.ordered_quantity || 0) - Number(item.received_quantity || 0));
      const accepted = Math.max(0, Number(receiptQuantities[item.id] ?? remaining));
      const rejected = Math.max(0, Number(receiptRejectedQuantities[item.id] ?? 0));
      return {
        order_item_id: item.id,
        ingredient_id: item.ingredient_id,
        ingredient_name: item.ingredient_name,
        received_quantity: accepted + rejected,
        accepted_quantity: accepted,
        rejected_quantity: rejected,
        unit: item.unit,
        batch_number: receiptBatches[item.id] || '',
        expiry_date: receiptExpiries[item.id] || null
      };
    }).filter((item) => item.received_quantity > 0);

    createReceiptMutation.mutate({
      purchase_order_id: selectedOrderForReceipt.id,
      destination_store_id: effectiveReceiptDestinationStoreId,
      receipt_date: receiptDate,
      notes: receiptNotes,
      items
    });
  };

  const submitInvoice = () => {
    createInvoiceMutation.mutate({
      ...invoiceForm,
      supplier_id: invoiceForm.supplier_id || null,
      purchase_order_id: invoiceForm.purchase_order_id || null,
      goods_receipt_id: invoiceForm.goods_receipt_id || null,
      subtotal: Number(invoiceForm.subtotal || 0),
      tax_amount: Number(invoiceForm.tax_amount || 0),
      total_amount: Number(invoiceForm.total_amount || 0)
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <PageHeader
          title="Procurement"
          description="Manage suppliers, requests, approvals, purchase orders, goods receiving, invoices, and supplier performance."
        >
          <Badge variant="outline" className="px-3 py-1 text-sm">
            Role: {role}
          </Badge>
        </PageHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
          <KPI title="Suppliers" value={procurementStats.supplierCount} subtitle="Configured vendor accounts" icon={Building2} tone="bg-blue-100 text-blue-700" />
          <KPI title="MR To Acknowledge" value={procurementStats.pendingMaterialRequests} subtitle="Chef-raised production requests" icon={ClipboardList} tone="bg-violet-100 text-violet-700" />
          <KPI title="Pending Requests" value={procurementStats.pendingRequests} subtitle="Awaiting approval" icon={ClipboardList} tone="bg-amber-100 text-amber-700" />
          <KPI title="Approved Orders" value={procurementStats.approvedOrders} subtitle="Ready for delivery" icon={ShoppingCart} tone="bg-indigo-100 text-indigo-700" />
          <KPI title="Received Orders" value={procurementStats.receivedOrders} subtitle="Fully delivered" icon={Truck} tone="bg-emerald-100 text-emerald-700" />
          <KPI title="Pending Invoices" value={procurementStats.pendingInvoices} subtitle="Need finance action" icon={DollarSign} tone="bg-rose-100 text-rose-700" />
          <KPI title="Low Stock Items" value={procurementStats.lowStockCount} subtitle="Auto-generate ready" icon={AlertTriangle} tone="bg-orange-100 text-orange-700" />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
            <TabsTrigger value="material-requests">Material Requests</TabsTrigger>
            <TabsTrigger value="requests">Purchase Requests</TabsTrigger>
            <TabsTrigger value="orders">Purchase Orders</TabsTrigger>
            <TabsTrigger value="receipts">Goods Receipts</TabsTrigger>
            <TabsTrigger value="invoices">Supplier Invoices</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
            <TabsTrigger value="price">Price Comparison</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>

          <TabsContent value="material-requests" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader>
                <CardTitle>Chef Material Requests</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request #</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead>Fulfillment Store</TableHead>
                      <TableHead>Production</TableHead>
                      <TableHead>Created By</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Est. Cost</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleMaterialRequests.map((request) => (
                      <TableRow key={request.id}>
                        <TableCell className="font-medium">{request.request_number}</TableCell>
                        <TableCell>{request.requesting_site_name || request.site_name || '-'}</TableCell>
                        <TableCell>{request.fulfillment_store_name || request.site_name || '-'}</TableCell>
                        <TableCell>{request.source_production_name || '-'}</TableCell>
                        <TableCell>{request.created_by_name || request.created_by || '-'}</TableCell>
                        <TableCell>{request.items?.length || 0}</TableCell>
                        <TableCell>{formatCurrency(request.total_estimated_cost)}</TableCell>
                        <TableCell>
                          <Badge className={statusBadgeClass(request.status)}>{String(request.status || '').replace(/_/g, ' ')}</Badge>
                        </TableCell>
                        <TableCell>
                          {request.status === 'pending_procurement_ack' && can('acknowledge_material_request') ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => acknowledgeMaterialRequestMutation.mutate({
                                id: request.id,
                                notes: 'Procurement team acknowledged and will source the shortage items.'
                              })}
                              disabled={acknowledgeMaterialRequestMutation.isPending}
                            >
                              Acknowledge
                            </Button>
                          ) : (
                            <span className="text-xs text-slate-400">{request.acknowledged_by_name ? `Ack by ${request.acknowledged_by_name}` : 'Tracked'}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {visibleMaterialRequests.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-10 text-center text-sm text-slate-500">
                          No production material requests are waiting for procurement.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="requests" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Purchase Requests</CardTitle>
                <div className="flex flex-wrap gap-2">
                  {canManageProcurement ? (
                    <>
                      <Button onClick={() => setRequestDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                        <Plus className="mr-2 h-4 w-4" />
                        New Request
                      </Button>
                      <Button variant="outline" onClick={() => autoGenerateRequestMutation.mutate()} disabled={autoGenerateRequestMutation.isPending}>
                        Auto Generate From Low Stock
                      </Button>
                    </>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request #</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>Requested By</TableHead>
                      <TableHead>Need By</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Est. Cost</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {requests.map((request) => (
                      <TableRow key={request.id}>
                        <TableCell className="font-medium">{request.request_number}</TableCell>
                        <TableCell>{request.site_name || '-'}</TableCell>
                        <TableCell>{request.requested_by_name || request.requested_by || '-'}</TableCell>
                        <TableCell>{request.needed_by || '-'}</TableCell>
                        <TableCell>{request.items?.length || 0}</TableCell>
                        <TableCell>{formatCurrency(request.total_estimated_cost)}</TableCell>
                        <TableCell>
                          <Badge className={statusBadgeClass(request.status)}>{String(request.status || '').replace(/_/g, ' ')}</Badge>
                        </TableCell>
                        <TableCell>
                          {canApproveProcurement && request.status === 'pending' ? (
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" onClick={() => approveRequestMutation.mutate({ id: request.id, status: 'approved' })}>Approve</Button>
                              <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => approveRequestMutation.mutate({ id: request.id, status: 'rejected' })}>Reject</Button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Workflow tracked</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {requests.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-10 text-center text-sm text-slate-500">
                          No purchase requests created yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader>
                <CardTitle>Low Stock Auto-Generation Queue</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>Stock</TableHead>
                      <TableHead>Min Level</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lowStockItems.slice(0, 12).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs text-slate-600">{resolveProcurementItemCode(item)}</TableCell>
                        <TableCell>{item.ingredient_name}</TableCell>
                        <TableCell>{item.site_name || '-'}</TableCell>
                        <TableCell>{formatNumber(item.quantity, 2)} {item.unit}</TableCell>
                        <TableCell>{formatNumber(item.min_stock_level, 2)} {item.unit}</TableCell>
                        <TableCell><Badge className={statusBadgeClass(item.status)}>{item.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                    {lowStockItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
                          No low stock inventory lines right now.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="orders" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Purchase Orders</CardTitle>
                {canManageProcurement ? (
                  <Button onClick={() => setOrderDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Create PO
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Order Date</TableHead>
                      <TableHead>Expected Delivery</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Received %</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell className="font-medium">{order.po_number}</TableCell>
                        <TableCell>{order.supplier_name}</TableCell>
                        <TableCell>{order.order_date}</TableCell>
                        <TableCell>{order.expected_delivery_date || '-'}</TableCell>
                        <TableCell>{formatCurrency(order.total_amount)}</TableCell>
                        <TableCell><Badge className={statusBadgeClass(order.status)}>{String(order.status || '').replace(/_/g, ' ')}</Badge></TableCell>
                        <TableCell>{formatNumber(order.received_percentage, 1)}%</TableCell>
                        <TableCell>
                          {canApproveProcurement && order.status === 'pending' ? (
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" onClick={() => updateOrderStatusMutation.mutate({ id: order.id, type: 'approve' })}>Approve</Button>
                              <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => updateOrderStatusMutation.mutate({ id: order.id, type: 'cancel' })}>Cancel</Button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Tracked</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {orders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-10 text-center text-sm text-slate-500">
                          No purchase orders created yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="receipts" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Goods Receiving Notes</CardTitle>
                {canManageProcurement ? (
                  <Button onClick={() => setReceiptDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Record GRN
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>GRN #</TableHead>
                      <TableHead>PO #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Destination Store</TableHead>
                      <TableHead>Receipt Date</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Accepted</TableHead>
                      <TableHead>Rejected</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((receipt) => (
                      <TableRow key={receipt.id}>
                        <TableCell className="font-medium">{receipt.grn_number}</TableCell>
                        <TableCell>{orders.find((entry) => entry.id === receipt.purchase_order_id)?.po_number || '-'}</TableCell>
                        <TableCell>{receipt.supplier_name}</TableCell>
                        <TableCell>{receipt.site_name || '-'}</TableCell>
                        <TableCell>{receipt.receipt_date}</TableCell>
                        <TableCell>{receipt.items?.length || 0}</TableCell>
                        <TableCell>{formatNumber((receipt.items || []).reduce((sum, item) => sum + Number(item.accepted_quantity || 0), 0), 2)}</TableCell>
                        <TableCell>{formatNumber((receipt.items || []).reduce((sum, item) => sum + Number(item.rejected_quantity || 0), 0), 2)}</TableCell>
                        <TableCell><Badge className={statusBadgeClass(receipt.status)}>{receipt.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                    {receipts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-10 text-center text-sm text-slate-500">
                          No goods receipts recorded yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="invoices" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Supplier Invoices</CardTitle>
                {canManageProcurement ? (
                  <Button onClick={() => setInvoiceDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Enter Invoice
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>PO #</TableHead>
                      <TableHead>Invoice Date</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((invoice) => (
                      <TableRow key={invoice.id}>
                        <TableCell className="font-medium">{invoice.invoice_number}</TableCell>
                        <TableCell>{invoice.supplier_name || '-'}</TableCell>
                        <TableCell>{orders.find((entry) => entry.id === invoice.purchase_order_id)?.po_number || '-'}</TableCell>
                        <TableCell>{invoice.invoice_date}</TableCell>
                        <TableCell>{formatCurrency(invoice.total_amount)}</TableCell>
                        <TableCell><Badge className={statusBadgeClass(invoice.status)}>{invoice.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                    {invoices.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
                          No supplier invoices entered yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="suppliers" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Supplier Management</CardTitle>
                {canManageSuppliers ? (
                  <Button onClick={() => { setEditingSupplier(null); setSupplierForm(supplierFormTemplate); setSupplierDialogOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Supplier
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Terms</TableHead>
                      <TableHead>Lead Time</TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {suppliers.map((supplier) => (
                      <TableRow key={supplier.id}>
                        <TableCell className="font-medium">{supplier.name}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <p>{supplier.contact_person || '-'}</p>
                            <p className="text-slate-500">{supplier.email || supplier.phone || '-'}</p>
                          </div>
                        </TableCell>
                        <TableCell>{supplier.payment_terms || '-'}</TableCell>
                        <TableCell>{formatNumber(supplier.lead_time_days)} day(s)</TableCell>
                        <TableCell>{formatNumber(supplier.rating, 1)}</TableCell>
                        <TableCell><Badge className={statusBadgeClass(supplier.status)}>{supplier.status}</Badge></TableCell>
                        <TableCell>
                          {canManageSuppliers ? (
                            <Button size="sm" variant="outline" onClick={() => openEditSupplier(supplier)}>Edit</Button>
                          ) : (
                            <span className="text-xs text-slate-400">Read only</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {suppliers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                          No suppliers configured yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="price" className="space-y-4">
            <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Supplier Price Comparison</CardTitle>
                <div className="w-full max-w-sm">
                  <IngredientSearchCombobox
                    value={priceIngredientId}
                    selectedIngredient={priceIngredient?.id === priceIngredientId ? priceIngredient : null}
                    allowClear
                    clearLabel="All ingredients"
                    onValueChange={(value, ingredient) => {
                      setPriceIngredientId(value);
                      setPriceIngredient(ingredient || null);
                    }}
                  />
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Latest Unit Price</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead>Effective Date</TableHead>
                      <TableHead>Lead Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {priceComparison.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-mono text-xs text-slate-600">{resolveProcurementItemCode(entry)}</TableCell>
                        <TableCell>{entry.ingredient_name}</TableCell>
                        <TableCell>{entry.supplier_name || '-'}</TableCell>
                        <TableCell>{formatCurrency(entry.unit_price)}</TableCell>
                        <TableCell>{entry.currency}</TableCell>
                        <TableCell>{entry.effective_date}</TableCell>
                        <TableCell>{formatNumber(entry.lead_time_days)} day(s)</TableCell>
                      </TableRow>
                    ))}
                    {priceComparison.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                          Price history will appear after purchase orders are created.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
            {!canViewPerformance ? (
              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardContent className="py-12 text-center text-sm text-slate-500">
                  Supplier performance metrics require procurement access.
                </CardContent>
              </Card>
            ) : (
              <Card className="border-0 shadow-sm ring-1 ring-slate-200/70">
                <CardHeader>
                  <CardTitle>Supplier Performance Dashboard</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead>
                        <TableHead>Total Orders</TableHead>
                        <TableHead>Total Spend</TableHead>
                        <TableHead>On-Time Rate</TableHead>
                        <TableHead>Lead Time</TableHead>
                        <TableHead>Fulfilment Rate</TableHead>
                        <TableHead>Quality Rating</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {performance.map((entry) => (
                        <TableRow key={entry.supplier_id}>
                          <TableCell className="font-medium">{entry.supplier_name}</TableCell>
                          <TableCell>{entry.total_orders}</TableCell>
                          <TableCell>{formatCurrency(entry.total_spend)}</TableCell>
                          <TableCell>{formatNumber(entry.on_time_delivery_rate, 1)}%</TableCell>
                          <TableCell>{formatNumber(entry.average_lead_time_days, 1)} day(s)</TableCell>
                          <TableCell>{formatNumber(entry.fulfilment_rate, 1)}%</TableCell>
                          <TableCell>{formatNumber(entry.quality_rating, 1)}</TableCell>
                        </TableRow>
                      ))}
                      {performance.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                            Supplier performance data will populate as procurement transactions are recorded.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={supplierDialogOpen} onOpenChange={setSupplierDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingSupplier ? 'Edit Supplier' : 'Add Supplier'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div><Label>Name</Label><Input value={supplierForm.name} onChange={(event) => setSupplierForm((current) => ({ ...current, name: event.target.value }))} /></div>
            <div><Label>Contact Person</Label><Input value={supplierForm.contact_person} onChange={(event) => setSupplierForm((current) => ({ ...current, contact_person: event.target.value }))} /></div>
            <div><Label>Email</Label><Input value={supplierForm.email} onChange={(event) => setSupplierForm((current) => ({ ...current, email: event.target.value }))} /></div>
            <div><Label>Phone</Label><Input value={supplierForm.phone} onChange={(event) => setSupplierForm((current) => ({ ...current, phone: event.target.value }))} /></div>
            <div><Label>City</Label><Input value={supplierForm.city} onChange={(event) => setSupplierForm((current) => ({ ...current, city: event.target.value }))} /></div>
            <div><Label>Country</Label><Input value={supplierForm.country} onChange={(event) => setSupplierForm((current) => ({ ...current, country: event.target.value }))} /></div>
            <div><Label>Payment Terms</Label><Input value={supplierForm.payment_terms} onChange={(event) => setSupplierForm((current) => ({ ...current, payment_terms: event.target.value }))} /></div>
            <div><Label>Lead Time Days</Label><Input type="number" value={supplierForm.lead_time_days} onChange={(event) => setSupplierForm((current) => ({ ...current, lead_time_days: event.target.value }))} /></div>
            <div><Label>Rating</Label><Input type="number" min="0" max="5" step="0.1" value={supplierForm.rating} onChange={(event) => setSupplierForm((current) => ({ ...current, rating: event.target.value }))} /></div>
            <div>
              <Label>Status</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={supplierForm.status} onChange={(event) => setSupplierForm((current) => ({ ...current, status: event.target.value }))}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div><Label>Address</Label><Input value={supplierForm.address} onChange={(event) => setSupplierForm((current) => ({ ...current, address: event.target.value }))} /></div>
          <div><Label>Categories (comma separated)</Label><Input value={supplierForm.categories} onChange={(event) => setSupplierForm((current) => ({ ...current, categories: event.target.value }))} /></div>
          <div><Label>Notes</Label><Textarea value={supplierForm.notes} onChange={(event) => setSupplierForm((current) => ({ ...current, notes: event.target.value }))} rows={4} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupplierDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => supplierMutation.mutate(supplierForm)} disabled={!supplierForm.name || supplierMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
              Save Supplier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={requestDialogOpen} onOpenChange={setRequestDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Create Purchase Request</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <Label>Site</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={requestForm.site_id || 'none'} onChange={(event) => setRequestForm((current) => ({ ...current, site_id: event.target.value === 'none' ? '' : event.target.value }))}>
                <option value="none">No specific site</option>
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            </div>
            <div><Label>Needed By</Label><Input type="date" value={requestForm.needed_by} onChange={(event) => setRequestForm((current) => ({ ...current, needed_by: event.target.value }))} /></div>
            <div>
              <Label>Priority</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={requestForm.priority} onChange={(event) => setRequestForm((current) => ({ ...current, priority: event.target.value }))}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Request Items</Label>
              <Button variant="outline" size="sm" onClick={() => setRequestForm((current) => ({ ...current, items: [...current.items, { ...requestItemTemplate }] }))}>
                Add Item
              </Button>
            </div>
            {requestForm.items.map((item, index) => (
              <div key={`request-item-${index}`} className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 p-4 md:grid-cols-6">
                <div>
                  <Label>Item Code</Label>
                  <Input className="mt-2 font-mono" value={resolveProcurementItemCode(item)} disabled />
                </div>
                <div>
                  <Label>Item Name</Label>
                  <IngredientSearchCombobox
                    className="mt-2"
                    value={item.ingredient_id}
                    selectedIngredient={item.ingredient_id ? {
                      id: item.ingredient_id,
                      item_code: item.item_code,
                      name: item.ingredient_name,
                      unit: item.unit
                    } : null}
                    siteId={requestForm.site_id}
                    onValueChange={(value, ingredient) => {
                    setRequestForm((current) => ({
                      ...current,
                      items: current.items.map((entry, entryIndex) => entryIndex === index ? {
                        ...entry,
                        ingredient_id: value,
                        item_code: getItemCode(ingredient, ''),
                        ingredient_name: ingredient?.name || '',
                        unit: ingredient?.unit || entry.unit,
                        estimated_unit_price: entry.estimated_unit_price || String(ingredient?.last_cost ?? ingredient?.cost_per_unit ?? '')
                      } : entry)
                    }));
                    }}
                  />
                </div>
                <div><Label>Quantity</Label><Input type="number" min="0" step="0.01" value={item.requested_quantity} onChange={(event) => setRequestForm((current) => ({ ...current, items: current.items.map((entry, entryIndex) => entryIndex === index ? { ...entry, requested_quantity: event.target.value } : entry) }))} /></div>
                <div><Label>Unit</Label><Input value={item.unit} onChange={(event) => setRequestForm((current) => ({ ...current, items: current.items.map((entry, entryIndex) => entryIndex === index ? { ...entry, unit: event.target.value } : entry) }))} /></div>
                <div><Label>Est. Unit Price</Label><Input type="number" min="0" step="0.01" value={item.estimated_unit_price} onChange={(event) => setRequestForm((current) => ({ ...current, items: current.items.map((entry, entryIndex) => entryIndex === index ? { ...entry, estimated_unit_price: event.target.value } : entry) }))} /></div>
                <div>
                  <Label>Preferred Supplier</Label>
                  <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={item.preferred_supplier_id || 'none'} onChange={(event) => setRequestForm((current) => ({ ...current, items: current.items.map((entry, entryIndex) => entryIndex === index ? { ...entry, preferred_supplier_id: event.target.value === 'none' ? '' : event.target.value } : entry) }))}>
                    <option value="none">Any supplier</option>
                    {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>

          <div><Label>Notes</Label><Textarea value={requestForm.notes} onChange={(event) => setRequestForm((current) => ({ ...current, notes: event.target.value }))} rows={4} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitRequest} disabled={createRequestMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">Submit Request</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={orderDialogOpen} onOpenChange={setOrderDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create Purchase Order</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <Label>Approved Request</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={orderForm.request_id || 'none'} onChange={(event) => setOrderForm((current) => ({ ...current, request_id: event.target.value === 'none' ? '' : event.target.value }))}>
                <option value="none">Select request</option>
                {requests.filter((request) => request.status === 'approved').map((request) => (
                  <option key={request.id} value={request.id}>{request.request_number}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Supplier</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={orderForm.supplier_id || 'none'} onChange={(event) => setOrderForm((current) => ({ ...current, supplier_id: event.target.value === 'none' ? '' : event.target.value }))}>
                <option value="none">Select supplier</option>
                {suppliers.filter((supplier) => supplier.status === 'active').map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </div>
            <div><Label>Expected Delivery</Label><Input type="date" value={orderForm.expected_delivery_date} onChange={(event) => setOrderForm((current) => ({ ...current, expected_delivery_date: event.target.value }))} /></div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div><Label>Tax Amount</Label><Input type="number" min="0" step="0.01" value={orderForm.tax_amount} onChange={(event) => setOrderForm((current) => ({ ...current, tax_amount: event.target.value }))} /></div>
            <div><Label>Notes</Label><Input value={orderForm.notes} onChange={(event) => setOrderForm((current) => ({ ...current, notes: event.target.value }))} /></div>
          </div>
          {selectedRequestForOrder ? (
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="mb-3 text-sm font-medium text-slate-900">Request Items</p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="text-right">Approved Quantity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedRequestForOrder.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs text-slate-600">{resolveProcurementItemCode(item)}</TableCell>
                        <TableCell className="font-medium text-slate-900">{item.ingredient_name}</TableCell>
                        <TableCell className="text-right">{formatNumber(item.approved_quantity || item.requested_quantity, 2)} {item.unit}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrderDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitOrder} disabled={!orderForm.request_id || !orderForm.supplier_id || createOrderMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">Create PO</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={receiptDialogOpen} onOpenChange={setReceiptDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Record Goods Receipt</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <Label>Purchase Order</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={receiptOrderId || 'none'} onChange={(event) => {
                setReceiptOrderId(event.target.value === 'none' ? '' : event.target.value);
                setReceiptDestinationStoreId('');
              }}>
                <option value="none">Select approved order</option>
                {orders.filter((order) => ['approved', 'partially_received'].includes(order.status)).map((order) => (
                  <option key={order.id} value={order.id}>{order.po_number} - {order.supplier_name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Destination Store</Label>
              <select
                aria-label="Destination Store"
                className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                value={effectiveReceiptDestinationStoreId || 'none'}
                disabled={!selectedOrderForReceipt || orderAlreadyTargetsStore}
                onChange={(event) => setReceiptDestinationStoreId(event.target.value === 'none' ? '' : event.target.value)}
              >
                <option value="none">
                  {selectedOrderForReceipt && receiptDestinationStores.length === 0
                    ? 'No active Store under this PO location'
                    : 'Select destination Store'}
                </option>
                {receiptDestinationStores.map((store) => (
                  <option key={store.id} value={store.id}>{store.name}</option>
                ))}
              </select>
              {selectedOrderSite ? (
                <p className="mt-1 text-xs text-slate-500">
                  PO location: {selectedOrderSite.name}
                </p>
              ) : null}
            </div>
            <div><Label>Receipt Date</Label><Input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} /></div>
          </div>
          {selectedOrderForReceipt ? (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 p-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item Code</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead>Remaining</TableHead>
                    <TableHead>Accepted Qty</TableHead>
                    <TableHead>Rejected Qty</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Batch / Lot</TableHead>
                    <TableHead>Expiry Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedOrderForReceipt.items.map((item) => {
                    const remaining = Math.max(0, Number(item.ordered_quantity || 0) - Number(item.received_quantity || 0));
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs text-slate-600">{resolveProcurementItemCode(item)}</TableCell>
                        <TableCell className="font-medium text-slate-900">{item.ingredient_name}</TableCell>
                        <TableCell>{formatNumber(remaining, 2)} {item.unit}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={`Accepted quantity for ${item.ingredient_name}`}
                            type="number"
                            min="0"
                            max={remaining}
                            step="0.01"
                            value={receiptQuantities[item.id] ?? remaining}
                            onChange={(event) => setReceiptQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={`Rejected quantity for ${item.ingredient_name}`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={receiptRejectedQuantities[item.id] ?? 0}
                            onChange={(event) => setReceiptRejectedQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                          />
                        </TableCell>
                        <TableCell>{item.unit || '—'}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={`Batch number for ${item.ingredient_name}`}
                            value={receiptBatches[item.id] || ''}
                            placeholder="Generated if blank"
                            onChange={(event) => setReceiptBatches((current) => ({ ...current, [item.id]: event.target.value }))}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={`Expiry date for ${item.ingredient_name}`}
                            type="date"
                            min={receiptDate || undefined}
                            value={receiptExpiries[item.id] || ''}
                            onChange={(event) => setReceiptExpiries((current) => ({ ...current, [item.id]: event.target.value }))}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
          <div><Label>Notes</Label><Textarea value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} rows={4} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiptDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitReceipt} disabled={!receiptOrderId || !effectiveReceiptDestinationStoreId || createReceiptMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">Post GRN</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Enter Supplier Invoice</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div><Label>Invoice Number</Label><Input value={invoiceForm.invoice_number} onChange={(event) => setInvoiceForm((current) => ({ ...current, invoice_number: event.target.value }))} /></div>
            <div><Label>Invoice Date</Label><Input type="date" value={invoiceForm.invoice_date} onChange={(event) => setInvoiceForm((current) => ({ ...current, invoice_date: event.target.value }))} /></div>
            <div><Label>Due Date</Label><Input type="date" value={invoiceForm.due_date} onChange={(event) => setInvoiceForm((current) => ({ ...current, due_date: event.target.value }))} /></div>
            <div>
              <Label>Supplier</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={invoiceForm.supplier_id || 'none'} onChange={(event) => setInvoiceForm((current) => ({ ...current, supplier_id: event.target.value === 'none' ? '' : event.target.value }))}>
                <option value="none">Select supplier</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Purchase Order</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={invoiceForm.purchase_order_id || 'none'} onChange={(event) => {
                const nextId = event.target.value === 'none' ? '' : event.target.value;
                const order = orders.find((entry) => entry.id === nextId);
                setInvoiceForm((current) => ({
                  ...current,
                  purchase_order_id: nextId,
                  supplier_id: current.supplier_id || order?.supplier_id || '',
                  subtotal: current.subtotal || String(order?.subtotal || ''),
                  total_amount: current.total_amount || String(order?.total_amount || '')
                }));
              }}>
                <option value="none">Select order</option>
                {orders.map((order) => <option key={order.id} value={order.id}>{order.po_number}</option>)}
              </select>
            </div>
            <div>
              <Label>Goods Receipt</Label>
              <select className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" value={invoiceForm.goods_receipt_id || 'none'} onChange={(event) => setInvoiceForm((current) => ({ ...current, goods_receipt_id: event.target.value === 'none' ? '' : event.target.value }))}>
                <option value="none">Select GRN</option>
                {receipts.map((receipt) => <option key={receipt.id} value={receipt.id}>{receipt.grn_number}</option>)}
              </select>
            </div>
            <div><Label>Subtotal</Label><Input type="number" min="0" step="0.01" value={invoiceForm.subtotal} onChange={(event) => setInvoiceForm((current) => ({ ...current, subtotal: event.target.value }))} /></div>
            <div><Label>Tax Amount</Label><Input type="number" min="0" step="0.01" value={invoiceForm.tax_amount} onChange={(event) => setInvoiceForm((current) => ({ ...current, tax_amount: event.target.value }))} /></div>
            <div><Label>Total Amount</Label><Input type="number" min="0" step="0.01" value={invoiceForm.total_amount} onChange={(event) => setInvoiceForm((current) => ({ ...current, total_amount: event.target.value }))} /></div>
          </div>
          <div><Label>Notes</Label><Textarea value={invoiceForm.notes} onChange={(event) => setInvoiceForm((current) => ({ ...current, notes: event.target.value }))} rows={4} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoiceDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitInvoice} disabled={!invoiceForm.invoice_number || createInvoiceMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">Save Invoice</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
