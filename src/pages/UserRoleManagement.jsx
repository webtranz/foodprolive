import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  GRANULAR_PAGE_ACCESS_PERMISSION,
  normalizeGranularPermissions,
  PAGE_ACCESS_PERMISSION_MAP,
  ROLE_PERMISSION_SECTIONS
} from '@/lib/rolePermissions';
import { pagePermissionMap } from '@/lib/pageAccess';
import {
  isManagementScopeSiteType,
  mergeSystemRoleProfiles,
  resolveManagementDashboardView
} from '../../shared/managementDashboardRoles.js';
import {
  getRoleLocationPolicy,
  isRolePrimarySiteType
} from '../../shared/roleLocationPolicy.js';
import {
  Briefcase,
  Building2,
  KeyRound,
  Mail,
  Network,
  Pencil,
  Shield,
  ShieldAlert,
  User,
  UserPlus,
  Users2
} from 'lucide-react';

const ROLE_STYLE_MAP = {
  admin: { color: 'bg-red-100 text-red-800 border-red-200', icon: Shield },
  manager: { color: 'bg-amber-100 text-amber-800 border-amber-200', icon: Briefcase },
  user: { color: 'bg-blue-100 text-blue-800 border-blue-200', icon: User },
  chef: { color: 'bg-orange-100 text-orange-800 border-orange-200', icon: Briefcase },
  general_manager: { color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: Shield },
  assistant_general_manager: { color: 'bg-indigo-100 text-indigo-800 border-indigo-200', icon: Users2 },
  area_manager: { color: 'bg-purple-100 text-purple-800 border-purple-200', icon: Network },
  project_manager: { color: 'bg-teal-100 text-teal-800 border-teal-200', icon: Briefcase },
  storekeeper: { color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: Building2 },
  procurement_officer: { color: 'bg-cyan-100 text-cyan-800 border-cyan-200', icon: Briefcase },
  production_supervisor: { color: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200', icon: Users2 },
  quality_controller: { color: 'bg-violet-100 text-violet-800 border-violet-200', icon: ShieldAlert },
  finance_controller: { color: 'bg-slate-100 text-slate-800 border-slate-200', icon: Shield }
};

const emptyUserForm = {
  full_name: '',
  email: '',
  password: '',
  role: 'user',
  site_id: '',
  allowed_site_ids: [],
  visibility_scope: 'subtree'
};

const emptyRoleForm = {
  role_key: '',
  name: '',
  description: '',
  access_level: 'user',
  permissions: [],
  is_active: true
};

function buildChildMap(sites) {
  const map = new Map();
  sites.forEach((site) => {
    const parentId = site.parent_site_id || null;
    if (!map.has(parentId)) {
      map.set(parentId, []);
    }
    map.get(parentId).push(site);
  });
  return map;
}

function normalizeRoleLabel(role) {
  return role?.name || role?.role_key?.replace(/_/g, ' ') || 'Role';
}

function preparePermissionsForEditing(permissions = []) {
  const existing = Array.from(new Set((permissions || []).filter(Boolean)));
  if (existing.includes(GRANULAR_PAGE_ACCESS_PERMISSION)) {
    return existing;
  }

  const can = (permission) => existing.includes(permission);
  const legacyPagePermissions = Object.entries(PAGE_ACCESS_PERMISSION_MAP)
    .filter(([page]) => {
      const requirement = pagePermissionMap[page];
      if (!requirement) return true;
      return Array.isArray(requirement)
        ? requirement.some((permission) => can(permission))
        : can(requirement);
    })
    .map(([, permission]) => permission);

  return normalizeGranularPermissions([...existing, ...legacyPagePermissions]);
}

function SiteAccessChecklist({ roots, childMap, selectedIds, onToggle, isSelectable = () => true }) {
  const renderNode = (site, depth = 0) => {
    const children = childMap.get(site.id) || [];
    const isChecked = selectedIds.includes(site.id);
    const canSelect = isSelectable(site);
    return (
      <div key={site.id} className="space-y-2">
        <label className={`flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm ${canSelect ? '' : 'text-slate-400'}`} style={{ marginLeft: depth * 14 }}>
          <Checkbox checked={isChecked} disabled={!canSelect && !isChecked} onCheckedChange={(checked) => onToggle(site.id, Boolean(checked))} />
          <span className="font-medium text-slate-700">{site.name}</span>
          <span className="text-xs text-slate-400">{site.type}</span>
        </label>
        {children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
      {roots.map((site) => renderNode(site))}
      {roots.length === 0 ? <p className="text-sm text-slate-500">No locations available.</p> : null}
    </div>
  );
}

function RoleLocationFields({
  roleKey,
  accessLevel,
  form,
  setForm,
  sites,
  roots,
  childMap,
  assignableSites,
  siteIsAssignable,
  onToggle
}) {
  if (accessLevel === 'admin') return null;
  const rolePolicy = getRoleLocationPolicy(roleKey);

  if (rolePolicy?.scope === 'all_areas') {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <p className="font-semibold">All Areas</p>
        <p className="mt-1 text-emerald-700">This executive role can view every Area, Project, and Store without administrator permissions.</p>
      </div>
    );
  }

  if (rolePolicy?.primary_site_type) {
    const options = assignableSites(roleKey);
    return (
      <div>
        <Label className="mb-1.5 block">Assigned {rolePolicy.assignment_label} *</Label>
        <Select
          value={form.site_id || 'none'}
          onValueChange={(value) => {
            const siteId = value === 'none' ? '' : value;
            setForm((current) => ({
              ...current,
              site_id: siteId,
              allowed_site_ids: siteId ? [siteId] : [],
              visibility_scope: rolePolicy.visibility_scope
            }));
          }}
        >
          <SelectTrigger><SelectValue placeholder={`Select ${rolePolicy.assignment_label.toLowerCase()}`} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select {rolePolicy.assignment_label.toLowerCase()}</SelectItem>
            {options.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-slate-500">
          {rolePolicy.scope === 'subtree'
            ? `Access includes this ${rolePolicy.assignment_label.toLowerCase()} and every record below it.`
            : `Access is limited to this ${rolePolicy.assignment_label.toLowerCase()} only.`}
        </p>
      </div>
    );
  }

  return (
    <>
      <div>
        <Label className="mb-1.5 block">Primary Location</Label>
        <Select value={form.site_id || 'none'} onValueChange={(value) => setForm((current) => ({ ...current, site_id: value === 'none' ? '' : value }))}>
          <SelectTrigger><SelectValue placeholder="Select primary location" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No primary location</SelectItem>
            {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="mb-1.5 flex items-center gap-2">
          <Network className="w-4 h-4 text-slate-500" /> Location Access
        </Label>
        <SiteAccessChecklist
          roots={roots}
          childMap={childMap}
          selectedIds={form.allowed_site_ids}
          onToggle={onToggle}
          isSelectable={(site) => siteIsAssignable(roleKey, site)}
        />
      </div>
      <div>
        <Label className="mb-1.5 block">Visibility Scope</Label>
        <Select value={form.visibility_scope} onValueChange={(value) => setForm((current) => ({ ...current, visibility_scope: value }))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="assigned_only">Assigned Locations Only</SelectItem>
            <SelectItem value="subtree">Assigned Locations and Children</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

function PermissionChecklist({ selected, onToggleMany }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-emerald-900">Granular section access</p>
          <p className="text-xs text-emerald-700">Select the pages this role can open, then choose its actions and approvals.</p>
        </div>
        <Badge variant="outline" className="border-emerald-300 bg-white text-emerald-800">
          {selected.filter((permission) => permission !== GRANULAR_PAGE_ACCESS_PERMISSION).length} selected
        </Badge>
      </div>

      {ROLE_PERMISSION_SECTIONS.map((section) => {
        const sectionPermissions = [
          ...section.subsections.map((subsection) => subsection.key),
          ...section.capabilities.map((capability) => capability.key)
        ];
        const selectedCount = sectionPermissions.filter((permission) => selected.includes(permission)).length;
        const sectionChecked = selectedCount === sectionPermissions.length;
        const sectionState = selectedCount > 0 && !sectionChecked ? 'indeterminate' : sectionChecked;

        return (
          <div key={section.key} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                <Checkbox
                  checked={sectionState}
                  onCheckedChange={(checked) => onToggleMany(sectionPermissions, Boolean(checked))}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800">{section.title}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{section.description}</span>
                </span>
              </label>
              <Badge variant="outline" className="bg-white text-slate-600">
                {selectedCount}/{sectionPermissions.length}
              </Badge>
            </div>

            <div className="space-y-5 p-4">
              <div>
                <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Subsections</h5>
                <div className="grid gap-2 md:grid-cols-2">
                  {section.subsections.map((subsection) => (
                    <label key={subsection.key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:border-emerald-300 hover:bg-emerald-50/40">
                      <Checkbox
                        checked={selected.includes(subsection.key)}
                        onCheckedChange={(checked) => onToggleMany([subsection.key], Boolean(checked))}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block text-sm font-medium text-slate-800">{subsection.label}</span>
                        <span className="mt-0.5 block text-xs leading-4 text-slate-500">{subsection.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Actions & approvals</h5>
                <div className="grid gap-2 md:grid-cols-2">
                  {section.capabilities.map((capability) => (
                    <label key={capability.key} className="flex cursor-pointer items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      <Checkbox
                        checked={selected.includes(capability.key)}
                        onCheckedChange={(checked) => onToggleMany([capability.key], Boolean(checked))}
                      />
                      <span>{capability.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function UserRoleManagement() {
  const { can, loading: permissionLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('users');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleEditOpen, setRoleEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editingRole, setEditingRole] = useState(null);
  const [userError, setUserError] = useState('');
  const [roleError, setRoleError] = useState('');
  const [createForm, setCreateForm] = useState(emptyUserForm);
  const [editForm, setEditForm] = useState(emptyUserForm);
  const [roleForm, setRoleForm] = useState(emptyRoleForm);
  const [editRoleForm, setEditRoleForm] = useState(emptyRoleForm);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: roleProfiles = [] } = useQuery({
    queryKey: ['roleProfiles'],
    queryFn: () => base44.entities.RoleProfile.list('name', 200)
  });

  const roots = useMemo(() => sites.filter((site) => !site.parent_site_id), [sites]);
  const childMap = useMemo(() => buildChildMap(sites), [sites]);
  const selectableRoleProfiles = useMemo(() => mergeSystemRoleProfiles(roleProfiles), [roleProfiles]);
  const roleMap = useMemo(
    () => Object.fromEntries(selectableRoleProfiles.map((role) => [role.role_key, role])),
    [selectableRoleProfiles]
  );
  const adminUsers = useMemo(
    () => users.filter((user) => (user.role_access_level || roleMap[user.role]?.access_level || user.role) === 'admin'),
    [users, roleMap]
  );
  const managementViewForRole = (roleKey) => {
    const selectedRole = roleMap[roleKey];
    return resolveManagementDashboardView({
      role: roleKey,
      dashboardVariant: selectedRole?.dashboard_variant,
      roleName: selectedRole?.name
    });
  };
  const assignableSitesForRole = (roleKey) => {
    const rolePolicy = getRoleLocationPolicy(roleKey);
    if (rolePolicy?.primary_site_type) {
      return sites.filter((site) => site.is_active !== false && isRolePrimarySiteType(roleKey, site.type));
    }
    const dashboardView = managementViewForRole(roleKey);
    return dashboardView
      ? sites.filter((site) => isManagementScopeSiteType(dashboardView, site.type))
      : sites;
  };
  const siteIsAssignableForRole = (roleKey, site) => (
    assignableSitesForRole(roleKey).some((candidate) => candidate.id === site.id)
  );

  const changeUserRole = (setter, role) => {
    const rolePolicy = getRoleLocationPolicy(role);
    const selectedRole = roleMap[role];
    setter((current) => ({
      ...current,
      role,
      site_id: '',
      allowed_site_ids: [],
      visibility_scope: selectedRole?.access_level === 'admin' || rolePolicy?.scope === 'all_areas'
        ? 'all_locations'
        : (rolePolicy?.visibility_scope || 'subtree')
    }));
  };

  const toggleSelectedSite = (setter, selectedIds, siteId, checked) => {
    setter((current) => ({
      ...current,
      allowed_site_ids: checked
        ? Array.from(new Set([...(selectedIds || []), siteId]))
        : (selectedIds || []).filter((id) => id !== siteId),
      site_id: current.site_id || siteId
    }));
  };

  const togglePermissions = (setter, permissions, checked) => {
    setter((current) => ({
      ...current,
      permissions: checked
        ? Array.from(new Set([...(current.permissions || []), ...permissions]))
        : (current.permissions || []).filter((item) => !permissions.includes(item))
    }));
  };

  const createUserMutation = useMutation({
    mutationFn: async (payload) => {
      const primarySite = sites.find((site) => site.id === payload.site_id);
      const selectedRole = roleMap[payload.role];
      const rolePolicy = getRoleLocationPolicy(payload.role);
      const hasGlobalAccess = selectedRole?.access_level === 'admin' || rolePolicy?.scope === 'all_areas';
      const allowedSiteIds = rolePolicy?.primary_site_type
        ? (payload.site_id ? [payload.site_id] : [])
        : Array.from(new Set([payload.site_id, ...(payload.allowed_site_ids || [])].filter(Boolean)));
      return base44.entities.User.create({
        full_name: payload.full_name.trim(),
        email: payload.email.trim().toLowerCase(),
        password: payload.password,
        role: payload.role,
        status: 'active',
        site_id: hasGlobalAccess ? null : (payload.site_id || null),
        site_name: hasGlobalAccess ? null : (primarySite?.name || null),
        allowed_site_ids: hasGlobalAccess ? [] : allowedSiteIds,
        visibility_scope: hasGlobalAccess ? 'all_locations' : (rolePolicy?.visibility_scope || payload.visibility_scope)
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateOpen(false);
      setCreateForm(emptyUserForm);
      setUserError('');
    },
    onError: (error) => setUserError(error.message || 'Failed to create user')
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.User.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditOpen(false);
      setEditingUser(null);
      setEditForm(emptyUserForm);
      setUserError('');
    },
    onError: (error) => setUserError(error.message || 'Failed to update user')
  });

  const createRoleMutation = useMutation({
    mutationFn: (payload) => base44.entities.RoleProfile.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roleProfiles'] });
      setRoleOpen(false);
      setRoleForm(emptyRoleForm);
      setRoleError('');
    },
    onError: (error) => setRoleError(error.message || 'Failed to create role')
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.RoleProfile.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roleProfiles'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setRoleEditOpen(false);
      setEditingRole(null);
      setEditRoleForm(emptyRoleForm);
      setRoleError('');
    },
    onError: (error) => setRoleError(error.message || 'Failed to update role')
  });

  const openEditUser = (user) => {
    setEditingUser(user);
    setEditForm({
      full_name: user.full_name || '',
      email: user.email || '',
      password: '',
      role: user.role || 'user',
      site_id: user.site_id || '',
      allowed_site_ids: Array.isArray(user.allowed_site_ids) ? user.allowed_site_ids : (user.site_id ? [user.site_id] : []),
      visibility_scope: user.visibility_scope || 'subtree'
    });
    setUserError('');
    setEditOpen(true);
  };

  const openEditRole = (role) => {
    setEditingRole(role);
    setEditRoleForm({
      role_key: role.role_key || '',
      name: role.name || '',
      description: role.description || '',
      access_level: role.access_level || 'user',
      permissions: preparePermissionsForEditing(role.permissions),
      is_active: role.is_active !== false
    });
    setRoleError('');
    setRoleEditOpen(true);
  };

  const handleCreateUser = (event) => {
    event.preventDefault();
    setUserError('');
    if (!createForm.full_name.trim()) {
      setUserError('Full name is required');
      return;
    }
    if (createForm.password.trim().length < 8) {
      setUserError('Password must be at least 8 characters long');
      return;
    }
    const createRolePolicy = getRoleLocationPolicy(createForm.role);
    if ((createRolePolicy?.primary_site_type || (managementViewForRole(createForm.role) && createRolePolicy?.scope !== 'all_areas')) && !createForm.site_id) {
      setUserError(`Select a primary ${createRolePolicy?.assignment_label || 'location'} for this role`);
      return;
    }
    createUserMutation.mutate(createForm);
  };

  const handleEditUser = (event) => {
    event.preventDefault();
    if (!editingUser) return;
    setUserError('');

    const selectedRole = roleMap[editForm.role];
    if (adminUsers.length === 1 && editingUser.id === adminUsers[0]?.id && selectedRole?.access_level !== 'admin') {
      setUserError('At least one administrator must remain in the system');
      return;
    }
    if (editForm.password && editForm.password.trim().length < 8) {
      setUserError('New password must be at least 8 characters long');
      return;
    }
    const editRolePolicy = getRoleLocationPolicy(editForm.role);
    if ((editRolePolicy?.primary_site_type || (managementViewForRole(editForm.role) && editRolePolicy?.scope !== 'all_areas')) && !editForm.site_id) {
      setUserError(`Select a primary ${editRolePolicy?.assignment_label || 'location'} for this role`);
      return;
    }

    const primarySite = sites.find((site) => site.id === editForm.site_id);
    const hasGlobalAccess = selectedRole?.access_level === 'admin' || editRolePolicy?.scope === 'all_areas';
    const allowedSiteIds = editRolePolicy?.primary_site_type
      ? (editForm.site_id ? [editForm.site_id] : [])
      : Array.from(new Set([editForm.site_id, ...(editForm.allowed_site_ids || [])].filter(Boolean)));

    updateUserMutation.mutate({
      id: editingUser.id,
      data: {
        full_name: editForm.full_name.trim(),
        role: editForm.role,
        site_id: hasGlobalAccess ? null : (editForm.site_id || null),
        site_name: hasGlobalAccess ? null : (primarySite?.name || null),
        allowed_site_ids: hasGlobalAccess ? [] : allowedSiteIds,
        visibility_scope: hasGlobalAccess ? 'all_locations' : (editRolePolicy?.visibility_scope || editForm.visibility_scope),
        ...(editForm.password.trim() ? { password: editForm.password.trim() } : {})
      }
    });
  };

  const handleCreateRole = (event) => {
    event.preventDefault();
    setRoleError('');
    if (!roleForm.role_key.trim() || !roleForm.name.trim()) {
      setRoleError('Role key and name are required');
      return;
    }
    createRoleMutation.mutate({
      ...roleForm,
      role_key: roleForm.role_key.trim().toLowerCase().replace(/\s+/g, '_'),
      name: roleForm.name.trim(),
      permissions: normalizeGranularPermissions(roleForm.permissions)
    });
  };

  const handleEditRole = (event) => {
    event.preventDefault();
    if (!editingRole) return;
    setRoleError('');
    updateRoleMutation.mutate({
      id: editingRole.id,
      data: {
        ...editRoleForm,
        name: editRoleForm.name.trim(),
        description: editRoleForm.description.trim(),
        permissions: normalizeGranularPermissions(editRoleForm.permissions)
      }
    });
  };

  if (permissionLoading || isLoading) {
    return <div className="p-8 text-slate-500">Loading...</div>;
  }

  if (!can('manage_users')) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <Card className="max-w-sm w-full text-center p-8">
          <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500 mt-2">Only administrators can access this page.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <PageHeader
          title="User & Role Management"
          description="Manage custom roles, standard operational roles, and project-specific user access"
        >
          {activeTab === 'users' ? (
            <Button onClick={() => { setCreateForm(emptyUserForm); setUserError(''); setCreateOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
              <UserPlus className="w-4 h-4 mr-2" /> Create User
            </Button>
          ) : (
            <Button onClick={() => { setRoleForm(emptyRoleForm); setRoleError(''); setRoleOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
              <Shield className="w-4 h-4 mr-2" /> Create Role
            </Button>
          )}
        </PageHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="roles">Roles & Permissions</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {selectableRoleProfiles.slice(0, 6).map((role) => {
                const style = ROLE_STYLE_MAP[role.role_key] || ROLE_STYLE_MAP[role.access_level] || ROLE_STYLE_MAP.user;
                const Icon = style.icon;
                const count = users.filter((user) => user.role === role.role_key).length;
                return (
                  <Card key={role.id} className="border-2 border-slate-100">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Icon className="w-5 h-5 text-slate-600" />
                          <CardTitle className="text-base">{normalizeRoleLabel(role)}</CardTitle>
                        </div>
                        <Badge className={style.color}>{count} users</Badge>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{role.description || 'Role profile'}</p>
                    </CardHeader>
                  </Card>
                );
              })}
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5" /> Access Matrix
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Assigned Scope</TableHead>
                      <TableHead>Visibility</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => {
                      const role = roleMap[user.role] || { role_key: user.role || 'user', name: user.role_name || user.role || 'User', access_level: user.role_access_level || 'user' };
                      const style = ROLE_STYLE_MAP[role.role_key] || ROLE_STYLE_MAP[role.access_level] || ROLE_STYLE_MAP.user;
                      const Icon = style.icon;
                      const rolePolicy = getRoleLocationPolicy(role.role_key);
                      const assignedCount = Array.isArray(user.allowed_site_ids) ? user.allowed_site_ids.length : (user.site_id ? 1 : 0);
                      return (
                        <TableRow key={user.id}>
                          <TableCell className="font-medium">{user.full_name || '-'}</TableCell>
                          <TableCell>{user.email}</TableCell>
                          <TableCell>
                            <Badge className={`${style.color} flex w-fit items-center gap-1`}>
                              <Icon className="w-3 h-3" />
                              {normalizeRoleLabel(role)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {rolePolicy?.scope === 'all_areas' || role.access_level === 'admin' ? (
                              <Badge variant="outline" className="flex w-fit items-center gap-1">
                                <Network className="w-3 h-3" />
                                {role.access_level === 'admin' ? 'All Locations' : 'All Areas'}
                              </Badge>
                            ) : user.site_name ? (
                              <Badge variant="outline" className="flex w-fit items-center gap-1">
                                <Building2 className="w-3 h-3" />
                                {user.site_name}
                              </Badge>
                            ) : (
                              <span className="text-xs text-slate-400">Unassigned</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-slate-600">
                            {role.access_level === 'admin'
                              ? 'All locations'
                              : rolePolicy?.scope === 'all_areas'
                                ? 'All areas and descendants'
                                : rolePolicy?.primary_site_type
                                  ? `${rolePolicy.assignment_label}${rolePolicy.scope === 'subtree' ? ' and descendants' : ' only'}`
                                  : `${user.visibility_scope || 'subtree'} • ${assignedCount} assigned`}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditUser(user)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="roles" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5" /> Role Library
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Role</TableHead>
                      <TableHead>Access Level</TableHead>
                      <TableHead>Permissions</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectableRoleProfiles.map((role) => {
                      const style = ROLE_STYLE_MAP[role.role_key] || ROLE_STYLE_MAP[role.access_level] || ROLE_STYLE_MAP.user;
                      const Icon = style.icon;
                      return (
                        <TableRow key={role.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Icon className="w-4 h-4 text-slate-600" />
                              <div>
                                <p className="font-medium text-slate-800">{role.name}</p>
                                <p className="text-xs text-slate-500">{role.role_key}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize">{role.access_level}</Badge>
                          </TableCell>
                          <TableCell className="text-sm text-slate-600">
                            {role.is_fallback && !role.permissions?.length
                              ? 'Built-in permissions'
                              : Array.isArray(role.permissions)
                              ? role.permissions.filter((permission) => permission !== GRANULAR_PAGE_ACCESS_PERMISSION).length
                              : 0}{role.is_fallback && !role.permissions?.length ? '' : ' permissions'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={role.is_active === false ? 'secondary' : 'default'}>
                              {role.is_system ? 'System' : 'Custom'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {role.is_fallback || role.is_system ? (
                              <span className="text-xs text-slate-400">Built-in</span>
                            ) : (
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditRole(role)}>
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-emerald-600" /> Create User
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Full Name</Label>
                <Input value={createForm.full_name} onChange={(event) => setCreateForm((current) => ({ ...current, full_name: event.target.value }))} required />
              </div>
              <div>
                <Label className="mb-1.5 block">Email Address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input type="email" className="pl-9" value={createForm.email} onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))} required />
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Password</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input type="password" minLength={8} className="pl-9" value={createForm.password} onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))} required />
                </div>
              </div>
              <div>
                <Label className="mb-1.5 block">Role</Label>
                <Select value={createForm.role} onValueChange={(value) => changeUserRole(setCreateForm, value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {selectableRoleProfiles.filter((role) => role.is_active !== false).map((role) => (
                      <SelectItem key={role.id} value={role.role_key}>{role.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <RoleLocationFields
              roleKey={createForm.role}
              accessLevel={roleMap[createForm.role]?.access_level || 'user'}
              form={createForm}
              setForm={setCreateForm}
              sites={sites}
              roots={roots}
              childMap={childMap}
              assignableSites={assignableSitesForRole}
              siteIsAssignable={siteIsAssignableForRole}
              onToggle={(siteId, checked) => toggleSelectedSite(setCreateForm, createForm.allowed_site_ids, siteId, checked)}
            />

            {userError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{userError}</div> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={createUserMutation.isPending}>
                {createUserMutation.isPending ? 'Creating...' : 'Create User'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-slate-600" /> Edit User
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditUser} className="space-y-4">
            <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-600">
              <strong>Email:</strong> {editingUser?.email}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Full Name</Label>
                <Input value={editForm.full_name} onChange={(event) => setEditForm((current) => ({ ...current, full_name: event.target.value }))} />
              </div>
              <div>
                <Label className="mb-1.5 block">Role</Label>
                <Select value={editForm.role} onValueChange={(value) => changeUserRole(setEditForm, value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {selectableRoleProfiles.filter((role) => role.is_active !== false).map((role) => (
                      <SelectItem key={role.id} value={role.role_key}>{role.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <RoleLocationFields
              roleKey={editForm.role}
              accessLevel={roleMap[editForm.role]?.access_level || 'user'}
              form={editForm}
              setForm={setEditForm}
              sites={sites}
              roots={roots}
              childMap={childMap}
              assignableSites={assignableSitesForRole}
              siteIsAssignable={siteIsAssignableForRole}
              onToggle={(siteId, checked) => toggleSelectedSite(setEditForm, editForm.allowed_site_ids, siteId, checked)}
            />

            <div>
              <Label className="mb-1.5 block">Reset Password</Label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input type="password" minLength={8} className="pl-9" value={editForm.password} onChange={(event) => setEditForm((current) => ({ ...current, password: event.target.value }))} placeholder="Leave blank to keep current password" />
              </div>
            </div>

            {userError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{userError}</div> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={updateUserMutation.isPending}>
                {updateUserMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={roleOpen} onOpenChange={setRoleOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-emerald-600" /> Create Custom Role
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateRole} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Role Key</Label>
                <Input value={roleForm.role_key} onChange={(event) => setRoleForm((current) => ({ ...current, role_key: event.target.value }))} placeholder="example: camp_supervisor" />
              </div>
              <div>
                <Label className="mb-1.5 block">Role Name</Label>
                <Input value={roleForm.name} onChange={(event) => setRoleForm((current) => ({ ...current, name: event.target.value }))} placeholder="Camp Supervisor" />
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block">Description</Label>
              <Textarea value={roleForm.description} onChange={(event) => setRoleForm((current) => ({ ...current, description: event.target.value }))} rows={3} />
            </div>
            <div>
              <Label className="mb-1.5 block">Access Level</Label>
              <Select value={roleForm.access_level} onValueChange={(value) => setRoleForm((current) => ({ ...current, access_level: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="admin">Administrator</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <PermissionChecklist
              selected={roleForm.permissions}
              onToggleMany={(permissions, checked) => togglePermissions(setRoleForm, permissions, checked)}
            />

            {roleError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{roleError}</div> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRoleOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={createRoleMutation.isPending}>
                {createRoleMutation.isPending ? 'Creating...' : 'Create Role'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={roleEditOpen} onOpenChange={setRoleEditOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-slate-600" /> Edit Role
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditRole} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Role Key</Label>
                <Input value={editRoleForm.role_key} disabled />
              </div>
              <div>
                <Label className="mb-1.5 block">Role Name</Label>
                <Input value={editRoleForm.name} onChange={(event) => setEditRoleForm((current) => ({ ...current, name: event.target.value }))} />
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block">Description</Label>
              <Textarea value={editRoleForm.description} onChange={(event) => setEditRoleForm((current) => ({ ...current, description: event.target.value }))} rows={3} />
            </div>
            <div>
              <Label className="mb-1.5 block">Access Level</Label>
              <Select value={editRoleForm.access_level} onValueChange={(value) => setEditRoleForm((current) => ({ ...current, access_level: value }))} disabled={editingRole?.is_system}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="admin">Administrator</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <PermissionChecklist
              selected={editRoleForm.permissions}
              onToggleMany={(permissions, checked) => togglePermissions(setEditRoleForm, permissions, checked)}
            />

            {editingRole?.is_system ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                System roles are editable for visibility and access tuning, but the role key stays locked for audit consistency.
              </div>
            ) : null}

            {roleError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{roleError}</div> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRoleEditOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={updateRoleMutation.isPending}>
                {updateRoleMutation.isPending ? 'Saving...' : 'Save Role'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
