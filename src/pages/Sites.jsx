import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Plus,
  Search,
  Building2,
  MapPin,
  Users,
  Phone,
  Mail,
  MoreVertical,
  Pencil,
  Trash2,
  Download,
  Network,
  Warehouse,
  ChefHat,
  Store,
  Building,
  Globe2,
  MapPinned,
  UserCog,
  Upload,
  FileSpreadsheet
} from 'lucide-react';
import SiteUserManager from '@/components/sites/SiteUserManager';
import { usePermissions } from '@/components/auth/usePermissions';
import { downloadCSV } from '../components/utils/exportData';

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

function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeHeader(value) {
  return normalizeLookup(value).replace(/[^a-z0-9]+/g, '_');
}

function pickValue(row, aliases) {
  for (const alias of aliases) {
    const aliasKey = normalizeHeader(alias);
    const matchKey = Object.keys(row).find((key) => normalizeHeader(key) === aliasKey);
    if (matchKey && row[matchKey] !== '' && row[matchKey] !== null && typeof row[matchKey] !== 'undefined') {
      return row[matchKey];
    }
  }
  return '';
}

function toBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeLookup(value);
  if (['false', '0', 'no', 'inactive'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'active'].includes(normalized)) return true;
  return fallback;
}

function resolveSiteReference(index, value) {
  const normalized = normalizeLookup(value);
  if (!normalized) return null;
  return index.find((site) => (
    normalizeLookup(site.id) === normalized ||
    normalizeLookup(site.name) === normalized ||
    normalizeLookup(site.project_code) === normalized ||
    normalizeLookup(site.hierarchy_path) === normalized
  )) || null;
}

function buildBulkSiteRows(rows, existingSites) {
  const previewRows = [];
  const items = [];
  const errors = [];
  const stagedSites = [...existingSites];

  rows.forEach((row, index) => {
    const explicitType = normalizeLookup(pickValue(row, ['type']));
    const projectValue = String(pickValue(row, ['project', 'project_name', 'parent_project']) || '').trim();
    const warehouseValue = String(pickValue(row, ['warehouse', 'warehouse_name']) || '').trim();
    const rawName = String(pickValue(row, ['name', 'site_name', 'location_name']) || '').trim();
    const codeValue = String(pickValue(row, ['project_code', 'code']) || '').trim();
    const city = String(pickValue(row, ['city']) || '').trim();
    const country = String(pickValue(row, ['country']) || '').trim();
    const address = String(pickValue(row, ['address']) || '').trim();
    const contactPerson = String(pickValue(row, ['contact_person']) || '').trim();
    const contactPhone = String(pickValue(row, ['contact_phone', 'phone']) || '').trim();
    const contactEmail = String(pickValue(row, ['contact_email', 'email']) || '').trim();
    const capacityRaw = String(pickValue(row, ['capacity']) || '').trim();
    const isActive = toBoolean(pickValue(row, ['is_active', 'active', 'status']), true);

    let resolvedType = explicitType;
    if (!SITE_TYPES.some((entry) => entry.value === resolvedType)) {
      resolvedType = warehouseValue ? 'warehouse' : 'location';
    }

    const resolvedName = (
      resolvedType === 'warehouse'
        ? (warehouseValue || rawName)
        : (rawName || projectValue || warehouseValue)
    ).trim();

    const parentLookupValue = resolvedType === 'warehouse'
      ? projectValue
      : pickValue(row, ['parent_project', 'parent_site', 'parent']);
    const parentSite = resolveSiteReference(stagedSites, parentLookupValue);
    const duplicateByName = stagedSites.find((site) => normalizeLookup(site.name) === normalizeLookup(resolvedName));
    const duplicateByCode = codeValue
      ? stagedSites.find((site) => normalizeLookup(site.project_code) === normalizeLookup(codeValue))
      : null;

    let status = 'Ready';
    if (!resolvedName) {
      status = 'Name is required';
      errors.push(`Row ${index + 2}: name is required`);
    } else if (resolvedType === 'warehouse' && !projectValue) {
      status = 'Warehouse rows require a project';
      errors.push(`Row ${index + 2}: warehouse rows require a project value`);
    } else if (resolvedType === 'warehouse' && !parentSite) {
      status = 'Parent project not found';
      errors.push(`Row ${index + 2}: parent project "${projectValue}" was not found`);
    } else if (duplicateByName) {
      status = `Already exists as ${duplicateByName.name}`;
      errors.push(`Row ${index + 2}: "${resolvedName}" already exists`);
    } else if (duplicateByCode) {
      status = `Project code ${codeValue} already exists`;
      errors.push(`Row ${index + 2}: project code "${codeValue}" already exists`);
    }

    previewRows.push({
      row: index + 2,
      name: resolvedName || '-',
      type: resolvedType,
      project: projectValue || (parentSite?.name || '-'),
      warehouse: warehouseValue || '-',
      status
    });

    if (status !== 'Ready') {
      return;
    }

    const payload = {
      name: resolvedName,
      project_code: codeValue || '',
      type: resolvedType,
      parent_site_id: parentSite?.id || '',
      address,
      city,
      country,
      capacity: capacityRaw ? parseInt(capacityRaw, 10) : null,
      contact_person: contactPerson,
      contact_phone: contactPhone,
      contact_email: contactEmail,
      is_active: isActive
    };

    items.push(payload);
    stagedSites.push({
      id: `staged-${index + 1}`,
      name: payload.name,
      project_code: payload.project_code,
      parent_site_id: payload.parent_site_id,
      hierarchy_path: payload.name
    });
  });

  return { items, errors, previewRows };
}

export default function Sites() {
  const [searchQuery, setSearchQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState(null);
  const [managingUsersSite, setManagingUsersSite] = useState(null);
  const [formData, setFormData] = useState(emptyForm);
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkSummary, setBulkSummary] = useState(null);

  const queryClient = useQueryClient();
  const { isAdmin } = usePermissions();

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

  const bulkCreateMutation = useMutation({
    mutationFn: async (rows) => {
      let imported = 0;
      let failed = 0;
      const failures = [];

      for (const row of rows) {
        try {
          await base44.entities.Site.create(row);
          imported += 1;
        } catch (error) {
          failed += 1;
          failures.push(error?.message || `Could not create ${row.name}`);
        }
      }

      return { imported, failed, failures };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setBulkSummary(result);
      setBulkError(result.failures?.[0] || '');
      if (!result.failed) {
        setBulkRows([]);
        setBulkFileName('');
      }
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
    camps: sites.filter((site) => site.type === 'camp').length,
    storage: sites.filter((site) => ['store', 'warehouse'].includes(site.type)).length
  }), [sites]);

  const parsedBulkImport = useMemo(
    () => buildBulkSiteRows(bulkRows, sites),
    [bulkRows, sites]
  );

  const openCreate = (parentId = '', type = 'location') => {
    if (!isAdmin) return;
    setEditingSite(null);
    setFormData({ ...emptyForm, parent_site_id: parentId, type });
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
    if (!editingSite && !isAdmin) return;
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

  const handleBulkFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      setBulkRows(rows);
      setBulkFileName(file.name);
      setBulkError('');
      setBulkSummary(null);
    } catch (error) {
      setBulkRows([]);
      setBulkFileName('');
      setBulkSummary(null);
      setBulkError(error.message || 'Could not read the project upload file');
    } finally {
      event.target.value = '';
    }
  };

  const handleDownloadProjectTemplate = () => {
    const worksheet = XLSX.utils.json_to_sheet([
      {
        warehouse: '',
        project: 'ABQAIQ CAMP',
        name: 'ABQAIQ CAMP',
        project_code: 'ABQ-CAMP',
        type: 'location',
        city: 'Abqaiq',
        country: 'Saudi Arabia'
      },
      {
        warehouse: 'ABQAIQ WAREHOUSE',
        project: 'ABQAIQ CAMP',
        name: 'ABQAIQ WAREHOUSE',
        project_code: 'ABQ-WH',
        type: 'warehouse',
        city: 'Abqaiq',
        country: 'Saudi Arabia'
      }
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Projects Upload');
    XLSX.writeFile(workbook, 'projects_bulk_template.xlsx');
  };

  const handleSubmitBulkImport = () => {
    if (!isAdmin) {
      setBulkError('Only administrators can import projects');
      return;
    }
    if (!parsedBulkImport.items.length) {
      setBulkError('Upload a valid project / warehouse file before importing');
      return;
    }
    bulkCreateMutation.mutate(parsedBulkImport.items);
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
                    {site.project_code ? <Badge variant="outline">Project Code: {site.project_code}</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{site.hierarchy_path || site.name}</p>
                  <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2 xl:grid-cols-4">
                    {(site.city || site.country) ? (
                      <p className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-slate-400" />
                        {[site.city, site.country].filter(Boolean).join(', ')}
                      </p>
                    ) : null}
                    {site.capacity ? (
                      <p className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-slate-400" />
                        {site.capacity} capacity
                      </p>
                    ) : null}
                    {site.contact_phone ? (
                      <p className="flex items-center gap-2">
                        <Phone className="h-4 w-4 text-slate-400" />
                        {site.contact_phone}
                      </p>
                    ) : null}
                    {site.contact_email ? (
                      <p className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-slate-400" />
                        {site.contact_email}
                      </p>
                    ) : null}
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
                  {isAdmin ? (
                    <>
                      <DropdownMenuItem onClick={() => openCreate(site.id, 'location')}>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Child
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openCreate(site.id, 'warehouse')}>
                        <Warehouse className="h-4 w-4 mr-2" />
                        Add Warehouse
                      </DropdownMenuItem>
                    </>
                  ) : null}
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
          title="Project Management"
          description="Manage company, region, project, kitchen, store, and warehouse hierarchy from one central view"
        >
          <Button variant="outline" onClick={() => downloadCSV(sites, 'project_hierarchy')}>
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          {isAdmin ? (
            <>
              <Button variant="outline" onClick={() => setBulkDialogOpen(true)}>
                <Upload className="w-4 h-4 mr-2" />
                Bulk Upload
              </Button>
              <Button variant="outline" onClick={() => openCreate('', 'warehouse')}>
                <Warehouse className="w-4 h-4 mr-2" />
                Add Warehouse
              </Button>
              <Button onClick={() => openCreate('', 'location')} className="bg-emerald-600 hover:bg-emerald-700">
                <Plus className="w-4 h-4 mr-2" />
                Add Project
              </Button>
            </>
          ) : null}
        </PageHeader>

        <div className="mb-6 grid gap-4 md:grid-cols-4">
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Companies</p><p className="mt-2 text-2xl font-semibold">{stats.companies}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Regions</p><p className="mt-2 text-2xl font-semibold">{stats.regions}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Camps</p><p className="mt-2 text-2xl font-semibold">{stats.camps}</p></CardContent></Card>
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
            title="No projects found"
            description={isAdmin
              ? 'Create your first company, region, or operating project to build the hierarchy'
              : 'No projects are available in your current access scope'}
            actionLabel={isAdmin ? 'Add Project' : undefined}
            onAction={isAdmin ? () => openCreate('', 'location') : undefined}
          />
        ) : (
          <div className="space-y-4">
            {roots.map((site) => renderNode(site))}
          </div>
        )}

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingSite ? 'Edit Project' : (formData.type === 'warehouse' ? 'Create Warehouse' : 'Create Project')}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>{formData.type === 'warehouse' ? 'Warehouse Name' : 'Project Name'}</Label>
                  <Input className="mt-1" value={formData.name} onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))} required />
                </div>
                <div>
                  <Label>Project Code</Label>
                  <Input className="mt-1" value={formData.project_code} onChange={(event) => setFormData((current) => ({ ...current, project_code: event.target.value }))} placeholder="e.g. PROJ-001" required />
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
                  <Label>Parent Project</Label>
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
                  {createMutation.isPending || updateMutation.isPending ? 'Saving...' : (editingSite ? 'Update Project' : (formData.type === 'warehouse' ? 'Create Warehouse' : 'Create Project'))}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={bulkDialogOpen}
          onOpenChange={(open) => {
            setBulkDialogOpen(open);
            if (!open) {
              setBulkError('');
              setBulkSummary(null);
            }
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Bulk Upload Projects / Warehouses</DialogTitle>
            </DialogHeader>
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <Card className="border-slate-200 shadow-none">
                  <CardContent className="space-y-4 p-4">
                    <div>
                      <Label>Upload CSV / Excel</Label>
                      <Input className="mt-1" type="file" accept=".csv,.xlsx,.xls" onChange={handleBulkFile} />
                      <p className="mt-2 text-xs text-slate-500">
                        Use the template fields `warehouse`, `project`, and `name`. Optional fields: `project_code`, `type`, `city`, `country`, `address`, `capacity`, `contact_person`, `contact_phone`, `contact_email`, `is_active`.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button type="button" variant="outline" onClick={handleDownloadProjectTemplate}>
                        <FileSpreadsheet className="mr-2 h-4 w-4" />
                        Download Template
                      </Button>
                    </div>
                    {bulkFileName ? (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                        Loaded file: <span className="font-medium text-slate-900">{bulkFileName}</span>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="border-slate-200 shadow-none">
                  <CardContent className="space-y-3 p-4 text-sm">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-slate-500">Ready rows</p>
                      <p className="mt-2 text-2xl font-semibold text-slate-900">{parsedBulkImport.items.length}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-slate-500">Row issues</p>
                      <p className="mt-2 text-2xl font-semibold text-amber-700">{parsedBulkImport.errors.length}</p>
                    </div>
                    {bulkSummary ? (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                        <p className="font-medium text-emerald-900">Last import result</p>
                        <p className="mt-2 text-sm text-emerald-800">
                          Imported {bulkSummary.imported} row{bulkSummary.imported === 1 ? '' : 's'}
                          {bulkSummary.failed ? `, failed ${bulkSummary.failed}` : ''}.
                        </p>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </div>

              {bulkError ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {bulkError}
                </div>
              ) : null}

              <Card className="border-slate-200 shadow-none">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Project</TableHead>
                        <TableHead>Warehouse</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsedBulkImport.previewRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                            Upload a file to preview project and warehouse rows.
                          </TableCell>
                        </TableRow>
                      ) : parsedBulkImport.previewRows.slice(0, 20).map((row) => (
                        <TableRow key={`project-preview-${row.row}`}>
                          <TableCell>{row.row}</TableCell>
                          <TableCell>{row.name}</TableCell>
                          <TableCell className="capitalize">{row.type}</TableCell>
                          <TableCell>{row.project}</TableCell>
                          <TableCell>{row.warehouse}</TableCell>
                          <TableCell>
                            <Badge className={row.status === 'Ready' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                              {row.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setBulkDialogOpen(false)}>
                  Close
                </Button>
                <Button type="button" className="bg-emerald-600 hover:bg-emerald-700" disabled={bulkCreateMutation.isPending} onClick={handleSubmitBulkImport}>
                  {bulkCreateMutation.isPending ? 'Importing...' : 'Import Projects'}
                </Button>
              </DialogFooter>
            </div>
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
