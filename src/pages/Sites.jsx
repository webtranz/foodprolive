import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Plus, Search, Building2, MapPin, Users, Phone, Mail, MoreVertical, Pencil, Trash2, Download, ChefHat, UserCog } from 'lucide-react';
import SiteUserManager from '@/components/sites/SiteUserManager';
import { downloadCSV } from '../components/utils/exportData';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

const SITE_TYPES = [
  { value: 'camp', label: 'Camp' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'branch', label: 'Branch' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'headquarters', label: 'Headquarters' }
];

const TYPE_COLORS = {
  camp: 'bg-blue-100 text-blue-700',
  kitchen: 'bg-emerald-100 text-emerald-700',
  branch: 'bg-amber-100 text-amber-700',
  warehouse: 'bg-purple-100 text-purple-700',
  headquarters: 'bg-slate-100 text-slate-700'
};

export default function Sites() {
  const [searchQuery, setSearchQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    project_code: '',
    type: 'kitchen',
    parent_site_id: '',
    address: '',
    city: '',
    country: '',
    capacity: '',
    contact_person: '',
    contact_phone: '',
    contact_email: '',
    is_active: true
  });
  const [showKitchens, setShowKitchens] = useState(false);
  const [selectedSiteForKitchens, setSelectedSiteForKitchens] = useState(null);
  const [managingUsersSite, setManagingUsersSite] = useState(null);

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
      resetForm();
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Site.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setFormOpen(false);
      setEditingSite(null);
      resetForm();
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

  const resetForm = () => {
    setFormData({
      name: '',
      project_code: '',
      type: 'kitchen',
      parent_site_id: '',
      address: '',
      city: '',
      country: '',
      capacity: '',
      contact_person: '',
      contact_phone: '',
      contact_email: '',
      is_active: true
    });
  };

  const filteredSites = sites.filter(site =>
    site.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    site.city?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleEdit = (site) => {
    setEditingSite(site);
    setFormData({
      name: site.name || '',
      project_code: site.project_code || '',
      type: site.type || 'kitchen',
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

  const parentSites = sites.filter(s => !s.parent_site_id);
  const getKitchensForSite = (siteId) => {
    return sites.filter(s => s.parent_site_id === siteId);
  };

  const handleDelete = (site) => {
    setSiteToDelete(site);
    setDeleteDialogOpen(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const submitData = {
      ...formData,
      capacity: formData.capacity ? parseInt(formData.capacity) : null
    };

    if (editingSite) {
      updateMutation.mutate({ id: editingSite.id, data: submitData });
    } else {
      createMutation.mutate(submitData);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto">
        <PageHeader 
          title="Sites" 
          description="Manage your production locations"
        >
          <Button 
            variant="outline"
            onClick={() => downloadCSV(filteredSites, 'sites')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            onClick={() => { setEditingSite(null); resetForm(); setFormOpen(true); }}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Site
          </Button>
        </PageHeader>

        {/* Search */}
        <div className="bg-white rounded-xl border border-slate-100 p-4 mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search sites..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : filteredSites.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No sites found"
            description="Add your first site to start managing locations"
            actionLabel="Add Site"
            onAction={() => setFormOpen(true)}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredSites.filter(s => !s.parent_site_id).map(site => {
              const kitchens = getKitchensForSite(site.id);
              return (
              <Card key={site.id} className="border-slate-100 shadow-sm hover:shadow-md transition-all duration-300">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center">
                        <Building2 className="w-6 h-6 text-emerald-600" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-900">{site.name}</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge className={TYPE_COLORS[site.type]}>{site.type}</Badge>
                          {!site.is_active && (
                            <Badge variant="outline" className="text-slate-500">Inactive</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(site)}>
                          <Pencil className="w-4 h-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setManagingUsersSite(site)}>
                          <UserCog className="w-4 h-4 mr-2" />
                          Manage Users
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          onClick={() => handleDelete(site)}
                          className="text-red-600"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="space-y-2">
                    {(site.city || site.country) && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <MapPin className="w-4 h-4 text-slate-400" />
                        <span>{[site.city, site.country].filter(Boolean).join(', ')}</span>
                      </div>
                    )}
                    {site.capacity && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Users className="w-4 h-4 text-slate-400" />
                        <span>{site.capacity} capacity</span>
                      </div>
                    )}
                    {site.contact_phone && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Phone className="w-4 h-4 text-slate-400" />
                        <span>{site.contact_phone}</span>
                      </div>
                    )}
                    {site.contact_email && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Mail className="w-4 h-4 text-slate-400" />
                        <span>{site.contact_email}</span>
                      </div>
                    )}
                  </div>

                  {/* Kitchens */}
                  {kitchens.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-slate-700">Kitchens ({kitchens.length})</p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedSiteForKitchens(site);
                            setFormData({ ...formData, parent_site_id: site.id, type: 'kitchen' });
                            setFormOpen(true);
                          }}
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add
                        </Button>
                      </div>
                      <div className="space-y-1">
                        {kitchens.map(kitchen => (
                          <div key={kitchen.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg text-sm">
                            <div className="flex items-center gap-2">
                              <ChefHat className="w-3 h-3 text-emerald-600" />
                              <span>{kitchen.name}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleEdit(kitchen)}
                            >
                              <Pencil className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {kitchens.length === 0 && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          setSelectedSiteForKitchens(site);
                          setFormData({ ...formData, parent_site_id: site.id, type: 'kitchen' });
                          setFormOpen(true);
                        }}
                      >
                        <Plus className="w-3 h-3 mr-2" />
                        Add Kitchen
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )})}
          </div>
        )}

        {/* Form Dialog */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSite ? 'Edit Site' : 'Add New Site'}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Site Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Main Kitchen"
                    className="mt-1"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="project_code">Project Code</Label>
                  <Input
                    id="project_code"
                    value={formData.project_code}
                    onChange={(e) => setFormData({ ...formData, project_code: e.target.value })}
                    placeholder="e.g., PRJ-001"
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="type">Type *</Label>
                  <Select
                    value={formData.type}
                    onValueChange={(value) => setFormData({ ...formData, type: value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SITE_TYPES.map(type => (
                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="parent_site">Parent Site (Optional)</Label>
                  <Select
                    value={formData.parent_site_id || 'none'}
                    onValueChange={(value) => setFormData({ ...formData, parent_site_id: value === 'none' ? '' : value })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {parentSites.filter(s => s.id !== editingSite?.id).map(site => (
                        <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="country">Country</Label>
                  <Input
                    id="country"
                    value={formData.country}
                    onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="address">Address</Label>
                <Input
                  id="address"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="capacity">Capacity (servings/day)</Label>
                <Input
                  id="capacity"
                  type="number"
                  value={formData.capacity}
                  onChange={(e) => setFormData({ ...formData, capacity: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="contact_person">Contact Person</Label>
                  <Input
                    id="contact_person"
                    value={formData.contact_person}
                    onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="contact_phone">Phone</Label>
                  <Input
                    id="contact_phone"
                    value={formData.contact_phone}
                    onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="contact_email">Email</Label>
                <Input
                  id="contact_email"
                  type="email"
                  value={formData.contact_email}
                  onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="is_active">Active</Label>
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {createMutation.isPending || updateMutation.isPending ? 'Saving...' : (editingSite ? 'Update' : 'Create')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Site User Manager */}
        {managingUsersSite && (
          <SiteUserManager site={managingUsersSite} onClose={() => setManagingUsersSite(null)} />
        )}

        {/* Delete Confirmation */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Site</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{siteToDelete?.name}"? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(siteToDelete?.id)}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
