import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Plus, Search, Building2, MapPin, Users, Phone, Mail, MoreVertical, Pencil, Trash2, Download, Network, Warehouse, ChefHat, Store, Building, Globe2, MapPinned, UserCog } from 'lucide-react';
import SiteUserManager from '@/components/sites/SiteUserManager';
import { downloadCSV } from '../components/utils/exportData';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

const SITE_TYPES = [
  { value: 'company', label: 'Company', icon: Globe2 },
  { value: 'region', label: 'Region', icon: MapPinned },
  { value: 'location', label: 'Location', icon: Building },
  { value: 'branch', label: 'Branch', icon: Building2 },
  { value: 'camp', label: 'Camp', icon: Building2 },
  { value: 'kitchen', label: 'Kitchen', icon: ChefHat },
  { value: 'store', label: 'Store', icon: Store },
  { value: 'warehouse', label: 'Warehouse', icon: Warehouse },
  { value: 'headquarters', label: 'Headquarters', icon: Building2 }
];

const TYPE_COLORS = {
  company: 'bg-slate-100 text-slate-700',
  region: 'bg-blue-100 text-blue-700',
  location: 'bg-emerald-100 text-emerald-700',
  branch: 'bg-amber-100 text-amber-700',
  camp: 'bg-cyan-100 text-cyan-700',
  kitchen: 'bg-lime-100 text-lime-700',
  store: 'bg-violet-100 text-violet-700',
  warehouse: 'bg-purple-100 text-purple-700',
  headquarters: 'bg-rose-100 text-rose-700'
};

const emptyForm = {
  name: '',
  project_code: '',
  type: 'location',
  parent_site_id: '',
  address: '',
  city: '',
  country: '',
  capacity: '',
  contact_person: '',
  contact_phone: '',
  contact_email: '',
  is_active: true
};

function getTypeMeta(type) {
  return SITE_TYPES.find((entry) => entry.value === type) || SITE_TYPES[2];
}

export default function Sites() {
  const [searchQuery, setSearchQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState(null);
  const [managingUsersSite, setManagingUsersSite] = useState(null);
  const [formData, setFormData] = useState(emptyForm);

  const queryClient = useQueryClient();

  const { data: sites = [], isLoading } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Site.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setFormOpen(false);
      setFormData(emptyForm);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Site.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setFormOpen(false);
      setEditingSite(null);
      setFormData(emptyForm);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Site.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setDeleteDialogOpen(false);
      setSiteToDelete(null);
    }
  });

  const childMap = useMemo(() => {
    const map = new Map();
    sites.forEach((site) => {
      const parentId = site.parent_site_id || null;
      if (!map.has(parentId)) {
        map.set(parentId, []);
      }
      map.get(parentId).push(site);
    });
    return map;
  }, [sites]);

  const filteredIds = useMemo(() => {
    const matches = sites.filter((site) =>
      `${site.name} ${site.city || ''} ${site.country || ''} ${site.type || ''} ${site.hierarchy_path || ''}`
        .toLowerCase()
        .includes(searchQuery.toLowerCase())
    );
    return new Set(matches.map((site) => site.id));
  }, [searchQuery, sites]);

  const roots = useMemo(() => {
    const baseRoots = sites.filter((site) => !site.parent_site_id);
    if (!searchQuery.trim()) {
      return baseRoots;
    }

    const includeWithChildren = (site) => {
      if (filteredIds.has(site.id)) return true;
      const children = childMap.get(site.id) || [];
      return children.some(includeWithChildren);
    };

    return baseRoots.filter(includeWithChildren);
  }, [childMap, filteredIds, searchQuery, sites]);

  const stats = useMemo(() => ({
    companies: sites.filter((site) => site.type === 'company').length,
    regions: sites.filter((site) => site.type === 'region').length,
    kitchens: sites.filter((site) => site.type === 'kitchen').length,
    storage: sites.filter((site) => ['store', 'warehouse'].includes(site.type)).length
  }), [sites]);

  const openCreate = (parentId = '') => {
    setEditingSite(null);
    setFormData({ ...emptyForm, parent_site_id: parentId });
    setFormOpen(true);
  };

  const openEdit = (site) => {
    setEditingSite(site);
    setFormData({
      name: site.name || '',
      project_code: site.project_code || '',
      type: site.type || 'location',
      parent_site_id: site.parent_site_id || '',
      address: site.address || '',
      city: site.city || '',
      country: site.country || '',
      capacity: site.capacity || '',
      contact_person: site.contact_person || '',
      contact_phone: site.contact_phone || '',
      contact_email: site.contact_email || '',
      is_active: site.is_active !== false
    });
    setFormOpen(true);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const payload = {
      ...formData,
      capacity: formData.capacity ? parseInt(formData.capacity, 10) : null
    };

    if (editingSite) {
      updateMutation.mutate({ id: editingSite.id, data: payload });
      return;
    }
    createMutation.mutate(payload);
  };

  const renderNode = (site, depth = 0) => {
    const children = childMap.get(site.id) || [];
    const typeMeta = getTypeMeta(site.type);
    const TypeIcon = typeMeta.icon;
    return (
      <div key={site.id} className="space-y-3">
        <Card className="border-slate-200 shadow-sm" style={{ marginLeft: depth * 18 }}>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100">
                  <TypeIcon className="h-5 w-5 text-slate-700" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-slate-900">{site.name}</h3>
                    <Badge className={TYPE_COLORS[site.type] || 'bg-slate-100 text-slate-700'}>{site.type}</Badge>
                    {!site.is_active ? <Badge variant="outline">Inactive</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{site.hierarchy_path || site.name}</p>
                  <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2 xl:grid-cols-4">
                    {(site.city || site.country) ? <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-slate-400" />{[site.city, site.country].filter(Boolean).join(', ')}</p> : null}
                    {site.capacity ? <p className="flex items-center gap-2"><Users className="h-4 w-4 text-slate-400" />{site.capacity} capacity</p> : null}
                    {site.contact_phone ? <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-slate-400" />{site.contact_phone}</p> : null}
                    {site.contact_email ? <p className="flex items-center gap-2"><Mail className="h-4 w-4 text-slate-400" />{site.contact_email}</p> : null}
                  </div>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => openCreate(site.id)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Child
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openEdit(site)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setManagingUsersSite(site)}>
                    <UserCog className="h-4 w-4 mr-2" />
                    Manage Users
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-red-600" onClick={() => { setSiteToDelete(site); setDeleteDialogOpen(true); }}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardContent>
        </Card>
        {children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader
          title="Multi-Location Management"
          description="Manage company, region, location, kitchen, store, and warehouse hierarchy from one central view"
        >
          <Button variant="outline" onClick={() => downloadCSV(sites, 'location_hierarchy')}>
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button onClick={() => openCreate()} className="bg-emerald-600 hover:bg-emerald-700">
            <Plus className="w-4 h-4 mr-2" />
            Add Node
          </Button>
        </PageHeader>

        <div className="mb-6 grid gap-4 md:grid-cols-4">
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Companies</p><p className="mt-2 text-2xl font-semibold">{stats.companies}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Regions</p><p className="mt-2 text-2xl font-semibold">{stats.regions}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Kitchens</p><p className="mt-2 text-2xl font-semibold">{stats.kitchens}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Stores / Warehouses</p><p className="mt-2 text-2xl font-semibold">{stats.storage}</p></CardContent></Card>
        </div>

        <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search hierarchy..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(6)].map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
          </div>
        ) : roots.length === 0 ? (
          <EmptyState
            icon={Network}
            title="No locations found"
            description="Create your first company, region, or operating location to build the hierarchy"
            actionLabel="Add Node"
            onAction={() => openCreate()}
          />
        ) : (
          <div className="space-y-4">
            {roots.map((site) => renderNode(site))}
          </div>
        )}

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingSite ? 'Edit Hierarchy Node' : 'Create Hierarchy Node'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Name</Label>
                  <Input className="mt-1" value={formData.name} onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))} required />
                </div>
                <div>
                  <Label>Code</Label>
                  <Input className="mt-1" value={formData.project_code} onChange={(event) => setFormData((current) => ({ ...current, project_code: event.target.value }))} />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Type</Label>
                  <Select value={formData.type} onValueChange={(value) => setFormData((current) => ({ ...current, type: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SITE_TYPES.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Parent Node</Label>
                  <Select value={formData.parent_site_id || 'none'} onValueChange={(value) => setFormData((current) => ({ ...current, parent_site_id: value === 'none' ? '' : value }))}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {sites.filter((site) => site.id !== editingSite?.id).map((site) => (
                        <SelectItem key={site.id} value={site.id}>{site.hierarchy_path || site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>City</Label>
                  <Input className="mt-1" value={formData.city} onChange={(event) => setFormData((current) => ({ ...current, city: event.target.value }))} />
                </div>
                <div>
                  <Label>Country</Label>
                  <Input className="mt-1" value={formData.country} onChange={(event) => setFormData((current) => ({ ...current, country: event.target.value }))} />
                </div>
              </div>

              <div>
                <Label>Address</Label>
                <Input className="mt-1" value={formData.address} onChange={(event) => setFormData((current) => ({ ...current, address: event.target.value }))} />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Capacity</Label>
                  <Input type="number" className="mt-1" value={formData.capacity} onChange={(event) => setFormData((current) => ({ ...current, capacity: event.target.value }))} />
                </div>
                <div className="flex items-center justify-between pt-8">
                  <Label>Active</Label>
                  <Switch checked={formData.is_active} onCheckedChange={(checked) => setFormData((current) => ({ ...current, is_active: checked }))} />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Contact Person</Label>
                  <Input className="mt-1" value={formData.contact_person} onChange={(event) => setFormData((current) => ({ ...current, contact_person: event.target.value }))} />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input className="mt-1" value={formData.contact_phone} onChange={(event) => setFormData((current) => ({ ...current, contact_phone: event.target.value }))} />
                </div>
              </div>

              <div>
                <Label>Email</Label>
                <Input type="email" className="mt-1" value={formData.contact_email} onChange={(event) => setFormData((current) => ({ ...current, contact_email: event.target.value }))} />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={createMutation.isPending || updateMutation.isPending}>
                  {createMutation.isPending || updateMutation.isPending ? 'Saving...' : (editingSite ? 'Update Node' : 'Create Node')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {managingUsersSite ? (
          <SiteUserManager site={managingUsersSite} onClose={() => setManagingUsersSite(null)} />
        ) : null}

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Hierarchy Node</AlertDialogTitle>
              <AlertDialogDescription>
                Delete "{siteToDelete?.name}" from the location hierarchy? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteMutation.mutate(siteToDelete?.id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
