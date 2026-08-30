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
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
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
  Store,
  MapPinned,
  UserCog,
  Upload,
  FileSpreadsheet
} from 'lucide-react';
import SiteUserManager from '@/components/sites/SiteUserManager';
import { usePermissions } from '@/components/auth/usePermissions';
import { downloadCSV } from '../components/utils/exportData';
import {
  getAllowedParentSites,
  getRequiredParentType,
  getSiteTypeLabel,
  getVisibleHierarchyRoots,
  isSupportedSiteType,
  normalizeSiteType,
  SITE_HIERARCHY_TYPES,
  validateCanonicalSiteParent
} from '../../shared/siteHierarchy.js';

const SITE_TYPES = [
  { value: SITE_HIERARCHY_TYPES.AREA, label: 'Area', icon: MapPinned },
  { value: SITE_HIERARCHY_TYPES.PROJECT, label: 'Project', icon: Building2 },
  { value: SITE_HIERARCHY_TYPES.STORE, label: 'Store', icon: Store }
];

const TYPE_COLORS = {
  area: 'bg-blue-100 text-blue-700',
  project: 'bg-emerald-100 text-emerald-700',
  store: 'bg-violet-100 text-violet-700',
};

const emptyForm = {
  name: '',
  project_code: '',
  type: SITE_HIERARCHY_TYPES.AREA,
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
  const canonicalType = normalizeSiteType(type);
  return SITE_TYPES.find((entry) => entry.value === canonicalType) || SITE_TYPES[0];
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
    const areaValue = String(pickValue(row, ['area', 'area_name', 'parent_area']) || '').trim();
    const projectValue = String(pickValue(row, ['project', 'project_name', 'parent_project']) || '').trim();
    const storeValue = String(pickValue(row, ['store', 'store_name', 'warehouse', 'warehouse_name']) || '').trim();
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

    const inferredType = storeValue
      ? SITE_HIERARCHY_TYPES.STORE
      : (projectValue ? SITE_HIERARCHY_TYPES.PROJECT : SITE_HIERARCHY_TYPES.AREA);
    const unsupportedExplicitType = explicitType && !isSupportedSiteType(explicitType);
    const resolvedType = normalizeSiteType(explicitType, inferredType);

    const resolvedName = (
      resolvedType === SITE_HIERARCHY_TYPES.STORE
        ? (rawName || storeValue)
        : resolvedType === SITE_HIERARCHY_TYPES.PROJECT
          ? (rawName || projectValue)
          : (rawName || areaValue)
    ).trim();

    const explicitParent = String(pickValue(row, ['parent', 'parent_site', 'parent_name']) || '').trim();
    const parentLookupValue = resolvedType === SITE_HIERARCHY_TYPES.PROJECT
      ? (explicitParent || areaValue)
      : resolvedType === SITE_HIERARCHY_TYPES.STORE
        ? (explicitParent || projectValue)
        : '';
    const parentSite = resolveSiteReference(stagedSites, parentLookupValue);
    const duplicateByName = stagedSites.find((site) => normalizeLookup(site.name) === normalizeLookup(resolvedName));
    const duplicateByCode = codeValue
      ? stagedSites.find((site) => normalizeLookup(site.project_code) === normalizeLookup(codeValue))
      : null;

    let status = 'Ready';
    const hierarchyError = validateCanonicalSiteParent({
      type: resolvedType,
      parent: parentSite,
      parentId: parentLookupValue
    });
    if (unsupportedExplicitType) {
      status = `Unsupported type "${explicitType}"`;
      errors.push(`Row ${index + 2}: unsupported type "${explicitType}"`);
    } else if (!resolvedName) {
      status = 'Name is required';
      errors.push(`Row ${index + 2}: name is required`);
    } else if (hierarchyError) {
      status = hierarchyError;
      errors.push(`Row ${index + 2}: ${hierarchyError}`);
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
      parent: parentLookupValue || '-',
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
      parent_reference: parentLookupValue,
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
      type: payload.type,
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
  const [deleteError, setDeleteError] = useState(null);
  const [managingUsersSite, setManagingUsersSite] = useState(null);
  const [formData, setFormData] = useState(emptyForm);
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkSummary, setBulkSummary] = useState(null);
  const [formError, setFormError] = useState('');

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
      setFormError('');
    },
    onError: (error) => setFormError(error?.message || 'Could not create this hierarchy record')
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Site.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setFormOpen(false);
      setEditingSite(null);
      setFormData(emptyForm);
      setFormError('');
    },
    onError: (error) => setFormError(error?.message || 'Could not update this hierarchy record')
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Site.delete(id, { includeDescendants: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setDeleteDialogOpen(false);
      setSiteToDelete(null);
      setDeleteError(null);
    },
    onError: (error) => setDeleteError({
      message: error?.message || 'Could not delete this hierarchy node',
      details: error?.data?.details || null
    })
  });

  const deactivateMutation = useMutation({
    mutationFn: (site) => base44.entities.Site.update(site.id, { is_active: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites'] });
      setDeleteDialogOpen(false);
      setSiteToDelete(null);
      setDeleteError(null);
    },
    onError: (error) => setDeleteError({
      message: error?.message || 'Could not deactivate this hierarchy node',
      details: error?.data?.details || null
    })
  });

  const bulkCreateMutation = useMutation({
    mutationFn: async (rows) => {
      let imported = 0;
      let failed = 0;
      const failures = [];
      const createdSites = [...sites];

      for (const row of rows) {
        try {
          const parent = row.parent_reference
            ? resolveSiteReference(createdSites, row.parent_reference)
            : null;
          const payload = { ...row };
          delete payload.parent_reference;
          payload.parent_site_id = parent?.id || '';
          const created = await base44.entities.Site.create(payload);
          createdSites.push(created);
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

  const deletePreview = useMemo(() => {
    if (!siteToDelete?.id) {
      return { directChildren: [], descendants: [] };
    }

    const directChildren = childMap.get(siteToDelete.id) || [];
    const descendants = [];
    const queue = [...directChildren];
    const visited = new Set([String(siteToDelete.id)]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current?.id || visited.has(String(current.id))) continue;
      visited.add(String(current.id));
      descendants.push(current);
      queue.push(...(childMap.get(current.id) || []));
    }

    return { directChildren, descendants };
  }, [childMap, siteToDelete]);

  const deleteErrorDetails = useMemo(() => {
    const details = deleteError?.details;
    if (!details) return [];
    const blockers = Array.isArray(details.blockers)
      ? details.blockers
      : (Array.isArray(details.dependencies) ? details.dependencies : []);
    if (blockers.length > 0) {
      return blockers.map((blocker) => {
        const count = Number(blocker?.count || 0);
        const label = blocker?.label || blocker?.entity_name || blocker?.source || 'linked records';
        return `${label}: ${count} linked record${count === 1 ? '' : 's'}`;
      });
    }
    if (Array.isArray(details)) {
      return details.map((detail) => (
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      ));
    }
    if (typeof details === 'object') {
      return Object.entries(details)
        .filter(([key]) => ![
          'root_site_id',
          'subtree_site_ids',
          'dependencies',
          'blockers'
        ].includes(key))
        .map(([key, value]) => (
          `${key.replace(/_/g, ' ')}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
        ));
    }
    return [String(details)];
  }, [deleteError]);

  const filteredIds = useMemo(() => {
    const matches = sites.filter((site) =>
      `${site.name} ${site.city || ''} ${site.country || ''} ${site.type || ''} ${site.hierarchy_path || ''}`
        .toLowerCase()
        .includes(searchQuery.toLowerCase())
    );
    return new Set(matches.map((site) => site.id));
  }, [searchQuery, sites]);

  const roots = useMemo(() => {
    const baseRoots = getVisibleHierarchyRoots(sites);
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
    areas: sites.filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.AREA).length,
    projects: sites.filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.PROJECT).length,
    stores: sites.filter((site) => normalizeSiteType(site.type) === SITE_HIERARCHY_TYPES.STORE).length,
    active: sites.filter((site) => site.is_active !== false).length
  }), [sites]);

  const parsedBulkImport = useMemo(
    () => buildBulkSiteRows(bulkRows, sites),
    [bulkRows, sites]
  );

  const openCreate = (parentId = '', type = SITE_HIERARCHY_TYPES.AREA) => {
    if (!isAdmin) return;
    setEditingSite(null);
    setFormData({ ...emptyForm, parent_site_id: parentId, type });
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (site) => {
    if (!isAdmin) return;
    setEditingSite(site);
    setFormData({
      name: site.name || '',
      project_code: site.project_code || '',
      type: normalizeSiteType(site.type),
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
    setFormError('');
    setFormOpen(true);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!isAdmin) return;
    const preserveLegacyType = Boolean(
      editingSite &&
      normalizeSiteType(editingSite.type) === formData.type &&
      !SITE_TYPES.some((entry) => entry.value === editingSite.type) &&
      String(editingSite.parent_site_id || '') === String(formData.parent_site_id || '')
    );
    const parent = sites.find((site) => String(site.id) === String(formData.parent_site_id)) || null;
    const hierarchyError = preserveLegacyType
      ? null
      : validateCanonicalSiteParent({
        type: formData.type,
        parent,
        parentId: formData.parent_site_id
      });
    if (hierarchyError) {
      setFormError(hierarchyError);
      return;
    }
    const payload = {
      ...formData,
      type: preserveLegacyType ? editingSite.type : formData.type,
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
        name: 'Eastern Area',
        type: 'area',
        parent: '',
        project_code: 'AREA-EAST',
        city: 'Dammam',
        country: 'Saudi Arabia'
      },
      {
        name: 'ABQAIQ CAMP',
        type: 'project',
        parent: 'Eastern Area',
        project_code: 'ABQ-CAMP',
        city: 'Abqaiq',
        country: 'Saudi Arabia'
      },
      {
        name: 'ABQAIQ MAIN STORE',
        type: 'store',
        parent: 'ABQAIQ CAMP',
        project_code: 'ABQ-ST',
        city: 'Abqaiq',
        country: 'Saudi Arabia'
      }
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Site Structure');
    XLSX.writeFile(workbook, 'area_project_store_template.xlsx');
  };

  const handleSubmitBulkImport = () => {
    if (!isAdmin) {
      setBulkError('Only administrators can import the site structure');
      return;
    }
    if (!parsedBulkImport.items.length) {
      setBulkError('Upload a valid Area / Project / Store file before importing');
      return;
    }
    bulkCreateMutation.mutate(parsedBulkImport.items);
  };

  const renderNode = (site, depth = 0) => {
    const children = childMap.get(site.id) || [];
    const canonicalType = normalizeSiteType(site.type);
    const typeMeta = getTypeMeta(canonicalType);
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
                    <Badge className={TYPE_COLORS[canonicalType] || 'bg-slate-100 text-slate-700'}>{getSiteTypeLabel(canonicalType)}</Badge>
                    {site.type !== canonicalType ? <Badge variant="outline">Legacy type: {site.type}</Badge> : null}
                    {!site.is_active ? <Badge variant="outline">Inactive</Badge> : null}
                    {site.project_code ? <Badge variant="outline">Code: {site.project_code}</Badge> : null}
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
              {isAdmin ? <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {isAdmin && canonicalType === SITE_HIERARCHY_TYPES.AREA ? (
                    <DropdownMenuItem onClick={() => openCreate(site.id, SITE_HIERARCHY_TYPES.PROJECT)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Project
                    </DropdownMenuItem>
                  ) : null}
                  {isAdmin && canonicalType === SITE_HIERARCHY_TYPES.PROJECT ? (
                    <DropdownMenuItem onClick={() => openCreate(site.id, SITE_HIERARCHY_TYPES.STORE)}>
                      <Store className="h-4 w-4 mr-2" />
                      Add Store
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={() => openEdit(site)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setManagingUsersSite(site)}>
                    <UserCog className="h-4 w-4 mr-2" />
                    Manage Users
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-red-600" onClick={() => {
                    setSiteToDelete(site);
                    setDeleteError(null);
                    deleteMutation.reset();
                    deactivateMutation.reset();
                    setDeleteDialogOpen(true);
                  }}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu> : null}
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
          title="Site Structure"
          description="Manage the operational hierarchy in a clear Area → Project → Store structure"
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
              <Button onClick={() => openCreate('', SITE_HIERARCHY_TYPES.AREA)} className="bg-emerald-600 hover:bg-emerald-700">
                <Plus className="w-4 h-4 mr-2" />
                Add Area
              </Button>
            </>
          ) : null}
        </PageHeader>

        <div className="mb-6 grid gap-4 md:grid-cols-4">
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Areas</p><p className="mt-2 text-2xl font-semibold">{stats.areas}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Projects</p><p className="mt-2 text-2xl font-semibold">{stats.projects}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Stores</p><p className="mt-2 text-2xl font-semibold">{stats.stores}</p></CardContent></Card>
          <Card><CardContent className="p-5"><p className="text-sm text-slate-500">Active Records</p><p className="mt-2 text-2xl font-semibold">{stats.active}</p></CardContent></Card>
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
            title="No site structure found"
            description={isAdmin
              ? 'Create the first Area, then add its Projects and Stores'
              : 'No Areas, Projects, or Stores are available in your current access scope'}
            actionLabel={isAdmin ? 'Add Area' : undefined}
            onAction={isAdmin ? () => openCreate('', SITE_HIERARCHY_TYPES.AREA) : undefined}
          />
        ) : (
          <div className="space-y-4">
            {roots.map((site) => renderNode(site))}
          </div>
        )}

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingSite ? `Edit ${getSiteTypeLabel(formData.type)}` : `Create ${getSiteTypeLabel(formData.type)}`}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>{getSiteTypeLabel(formData.type)} Name</Label>
                  <Input className="mt-1" value={formData.name} onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))} required />
                </div>
                <div>
                  <Label>{getSiteTypeLabel(formData.type)} Code</Label>
                  <Input className="mt-1" value={formData.project_code} onChange={(event) => setFormData((current) => ({ ...current, project_code: event.target.value }))} placeholder="e.g. PROJ-001" required />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Type</Label>
                  <Select value={formData.type} onValueChange={(value) => setFormData((current) => ({ ...current, type: value, parent_site_id: '' }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SITE_TYPES.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{getRequiredParentType(formData.type) ? `Parent ${getSiteTypeLabel(getRequiredParentType(formData.type))}` : 'Parent'}</Label>
                  <Select disabled={!getRequiredParentType(formData.type)} value={formData.parent_site_id || 'none'} onValueChange={(value) => setFormData((current) => ({ ...current, parent_site_id: value === 'none' ? '' : value }))}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder={getRequiredParentType(formData.type) ? 'Select parent' : 'Top-level Area'} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{getRequiredParentType(formData.type) ? 'Select parent' : 'Top-level Area'}</SelectItem>
                      {getAllowedParentSites(formData.type, sites, editingSite?.id).map((site) => (
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

              {formError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div>
              ) : null}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={createMutation.isPending || updateMutation.isPending}>
                  {createMutation.isPending || updateMutation.isPending ? 'Saving...' : (editingSite ? `Update ${getSiteTypeLabel(formData.type)}` : `Create ${getSiteTypeLabel(formData.type)}`)}
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
              <DialogTitle>Bulk Upload Site Structure</DialogTitle>
            </DialogHeader>
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <Card className="border-slate-200 shadow-none">
                  <CardContent className="space-y-4 p-4">
                    <div>
                      <Label>Upload CSV / Excel</Label>
                      <Input className="mt-1" type="file" accept=".csv,.xlsx,.xls" onChange={handleBulkFile} />
                      <p className="mt-2 text-xs text-slate-500">
                        Add rows in Area, Project, then Store order. Required fields: `name` and `type`; Projects and Stores also require `parent`. Optional fields include `project_code`, address, contact, capacity, and active status.
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
                        <TableHead>Parent</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsedBulkImport.previewRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-8 text-center text-slate-500">
                            Upload a file to preview Area, Project, and Store rows.
                          </TableCell>
                        </TableRow>
                      ) : parsedBulkImport.previewRows.slice(0, 20).map((row) => (
                        <TableRow key={`project-preview-${row.row}`}>
                          <TableCell>{row.row}</TableCell>
                          <TableCell>{row.name}</TableCell>
                          <TableCell className="capitalize">{row.type}</TableCell>
                          <TableCell>{row.parent}</TableCell>
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
                  {bulkCreateMutation.isPending ? 'Importing...' : 'Import Site Structure'}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {managingUsersSite ? (
          <SiteUserManager site={managingUsersSite} onClose={() => setManagingUsersSite(null)} />
        ) : null}

        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            if (deleteMutation.isPending || deactivateMutation.isPending) return;
            setDeleteDialogOpen(open);
            if (!open) {
              setSiteToDelete(null);
              setDeleteError(null);
              deleteMutation.reset();
              deactivateMutation.reset();
            }
          }}
        >
          <AlertDialogContent className="max-w-xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {getSiteTypeLabel(siteToDelete?.type)}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-left">
                  <p>
                    Delete <span className="font-medium text-slate-900">{siteToDelete?.name}</span> and its unused descendants from the location hierarchy?
                  </p>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <p><span className="font-medium">Direct descendants:</span> {deletePreview.directChildren.length}</p>
                    <p><span className="font-medium">Total subtree:</span> {deletePreview.descendants.length + 1} node{deletePreview.descendants.length === 0 ? '' : 's'}</p>
                    {deletePreview.directChildren.length > 0 ? (
                      <p className="mt-2">
                        <span className="font-medium">Directly below:</span>{' '}
                        {deletePreview.directChildren.slice(0, 8).map((site) => site.name).join(', ')}
                        {deletePreview.directChildren.length > 8 ? `, and ${deletePreview.directChildren.length - 8} more` : ''}
                      </p>
                    ) : null}
                    {deletePreview.descendants.length > deletePreview.directChildren.length ? (
                      <p className="mt-1">
                        <span className="font-medium">Full subtree:</span>{' '}
                        {deletePreview.descendants.slice(0, 12).map((site) => site.name).join(', ')}
                        {deletePreview.descendants.length > 12 ? `, and ${deletePreview.descendants.length - 12} more` : ''}
                      </p>
                    ) : null}
                  </div>
                  <p>
                    Only unused nodes will be removed. If any node has users, inventory, production, procurement, POS, or other operational history, deletion will stop without removing the subtree.
                  </p>
                  <p className="font-medium text-red-700">This action cannot be undone.</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                <p className="font-medium">This hierarchy cannot be deleted</p>
                <p className="mt-1">{deleteError.message}</p>
                {deleteErrorDetails.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {deleteErrorDetails.map((detail) => <li key={detail}>{detail}</li>)}
                  </ul>
                ) : null}
                <p className="mt-2">
                  {deletePreview.descendants.length > 0
                    ? 'Move or deactivate the linked child locations and operational records, then try again.'
                    : 'Remove or reassign the linked records, or deactivate this location to preserve its history.'}
                </p>
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending || deactivateMutation.isPending}>Cancel</AlertDialogCancel>
              {deleteError && deletePreview.descendants.length === 0 && siteToDelete?.is_active !== false ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={deleteMutation.isPending || deactivateMutation.isPending}
                  onClick={() => deactivateMutation.mutate(siteToDelete)}
                >
                  {deactivateMutation.isPending ? 'Deactivating...' : 'Deactivate Instead'}
                </Button>
              ) : null}
              <Button
                type="button"
                className="bg-red-600 hover:bg-red-700"
                disabled={!siteToDelete?.id || deleteMutation.isPending || deactivateMutation.isPending}
                onClick={() => {
                  setDeleteError(null);
                  deleteMutation.mutate(siteToDelete.id);
                }}
              >
                {deleteMutation.isPending
                  ? 'Checking & deleting...'
                  : `Delete ${deletePreview.descendants.length + 1} node${deletePreview.descendants.length === 0 ? '' : 's'}`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
