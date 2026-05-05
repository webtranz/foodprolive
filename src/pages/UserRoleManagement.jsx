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

const PERMISSION_GROUPS = [
  {
    title: 'Executive Access',
    permissions: ['view_dashboard', 'view_reports', 'export_data']
  },
  {
    title: 'Master Data',
    permissions: ['manage_projects', 'manage_ingredients', 'manage_recipes', 'manage_menu_planning']
  },
  {
    title: 'Operations',
    permissions: [
      'manage_inventory', 'transfer_inventory', 'manage_production',
      'create_production_request', 'edit_production_request', 'submit_production_request',
      'review_production_request', 'approve_production_request', 'reject_production_request',
      'request_changes_production', 'approve_production', 'start_production', 'complete_production',
      'create_material_request', 'view_material_request', 'acknowledge_material_request'
    ]
  },
  {
    title: 'Supply Chain',
    permissions: ['manage_procurement', 'approve_procurement', 'manage_suppliers', 'manage_pos', 'manage_erp', 'manage_forecasting']
  },
  {
    title: 'People & Compliance',
    permissions: ['manage_attendance', 'approve_attendance', 'manage_quality', 'manage_waste', 'approve_waste', 'manage_users', 'manage_roles']
  }
];

const PERMISSION_LABELS = {
  view_dashboard: 'View dashboard',
  view_reports: 'View reports',
  export_data: 'Export data',
  manage_projects: 'Manage projects',
  manage_ingredients: 'Manage ingredients',
  manage_inventory: 'Manage inventory',
  transfer_inventory: 'Transfer inventory',
  manage_recipes: 'Manage recipes',
  manage_menu_planning: 'Manage menu planning',
  manage_production: 'Manage production plans',
  create_production_request: 'Create production requests',
  edit_production_request: 'Edit production requests',
  submit_production_request: 'Submit production requests for approval',
  review_production_request: 'Review production requests',
  approve_production_request: 'Approve production requests',
  reject_production_request: 'Reject production requests',
  request_changes_production: 'Request changes on production requests',
  approve_production: 'Approve production plans',
  start_production: 'Start approved production',
  complete_production: 'Complete production batches',
  create_material_request: 'Create material requests',
  view_material_request: 'View material requests',
  acknowledge_material_request: 'Acknowledge material requests',
  manage_procurement: 'Manage procurement',
  approve_procurement: 'Approve procurement',
  manage_suppliers: 'Manage suppliers',
  manage_waste: 'Manage food waste',
  approve_waste: 'Approve high-value waste',
  manage_pos: 'Manage POS integration',
  manage_erp: 'Manage ERP integration',
  manage_forecasting: 'Manage forecasting',
  manage_attendance: 'Manage attendance',
  approve_attendance: 'Approve attendance',
  manage_quality: 'Manage quality control',
  manage_users: 'Manage users',
  manage_roles: 'Manage roles'
};

const ROLE_STYLE_MAP = {
  admin: { color: 'bg-red-100 text-red-800 border-red-200', icon: Shield },
  manager: { color: 'bg-amber-100 text-amber-800 border-amber-200', icon: Briefcase },
  user: { color: 'bg-blue-100 text-blue-800 border-blue-200', icon: User },
  chef: { color: 'bg-orange-100 text-orange-800 border-orange-200', icon: Briefcase },
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

function SiteAccessChecklist({ roots, childMap, selectedIds, onToggle }) {
  const renderNode = (site, depth = 0) => {
    const children = childMap.get(site.id) || [];
    const isChecked = selectedIds.includes(site.id);
    return (
      <div key={site.id} className="space-y-2">
        <label className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" style={{ marginLeft: depth * 14 }}>
          <Checkbox checked={isChecked} onCheckedChange={(checked) => onToggle(site.id, Boolean(checked))} />
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

function PermissionChecklist({ selected, onToggle }) {
  return (
    <div className="space-y-4">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.title} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h4 className="mb-3 text-sm font-semibold text-slate-700">{group.title}</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {group.permissions.map((permission) => (
              <label key={permission} className="flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm">
                <Checkbox checked={selected.includes(permission)} onCheckedChange={(checked) => onToggle(permission, Boolean(checked))} />
                <span>{PERMISSION_LABELS[permission] || permission}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
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
  const roleMap = useMemo(() => Object.fromEntries(roleProfiles.map((role) => [role.role_key, role])), [roleProfiles]);
  const adminUsers = useMemo(
    () => users.filter((user) => (user.role_access_level || roleMap[user.role]?.access_level || user.role) === 'admin'),
    [users, roleMap]
  );

  const toggleSelectedSite = (setter, selectedIds, siteId, checked) => {
    setter((current) => ({
      ...current,
      allowed_site_ids: checked
        ? Array.from(new Set([...(selectedIds || []), siteId]))
        : (selectedIds || []).filter((id) => id !== siteId),
      site_id: current.site_id || siteId
    }));
  };

  const togglePermission = (setter, selected, permission, checked) => {
    setter((current) => ({
      ...current,
      permissions: checked
        ? Array.from(new Set([...(selected || []), permission]))
        : (selected || []).filter((item) => item !== permission)
    }));
  };

  const createUserMutation = useMutation({
    mutationFn: async (payload) => {
      const primarySite = sites.find((site) => site.id === payload.site_id);
      const selectedRole = roleMap[payload.role];
      const allowedSiteIds = Array.from(new Set([payload.site_id, ...(payload.allowed_site_ids || [])].filter(Boolean)));
      return base44.entities.User.create({
        full_name: payload.full_name.trim(),
        email: payload.email.trim().toLowerCase(),
        password: payload.password,
        role: payload.role,
        status: 'active',
        site_id: selectedRole?.access_level === 'admin' ? null : (payload.site_id || null),
        site_name: selectedRole?.access_level === 'admin' ? null : (primarySite?.name || null),
        allowed_site_ids: selectedRole?.access_level === 'admin' ? [] : allowedSiteIds,
        visibility_scope: selectedRole?.access_level === 'admin' ? 'all_locations' : payload.visibility_scope
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
      permissions: Array.isArray(role.permissions) ? role.permissions : [],
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

    const primarySite = sites.find((site) => site.id === editForm.site_id);
    const allowedSiteIds = Array.from(new Set([editForm.site_id, ...(editForm.allowed_site_ids || [])].filter(Boolean)));

    updateUserMutation.mutate({
      id: editingUser.id,
      data: {
        full_name: editForm.full_name.trim(),
        role: editForm.role,
        site_id: selectedRole?.access_level === 'admin' ? null : (editForm.site_id || null),
        site_name: selectedRole?.access_level === 'admin' ? null : (primarySite?.name || null),
        allowed_site_ids: selectedRole?.access_level === 'admin' ? [] : allowedSiteIds,
        visibility_scope: selectedRole?.access_level === 'admin' ? 'all_locations' : editForm.visibility_scope,
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
      name: roleForm.name.trim()
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
        description: editRoleForm.description.trim()
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
              {roleProfiles.slice(0, 6).map((role) => {
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
                      <TableHead>Primary Project</TableHead>
                      <TableHead>Visibility</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => {
                      const role = roleMap[user.role] || { role_key: user.role || 'user', name: user.role_name || user.role || 'User', access_level: user.role_access_level || 'user' };
                      const style = ROLE_STYLE_MAP[role.role_key] || ROLE_STYLE_MAP[role.access_level] || ROLE_STYLE_MAP.user;
                      const Icon = style.icon;
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
                            {user.site_name ? (
                              <Badge variant="outline" className="flex w-fit items-center gap-1">
                                <Building2 className="w-3 h-3" />
                                {user.site_name}
                              </Badge>
                            ) : (
                              <span className="text-xs text-slate-400">{role.access_level === 'admin' ? 'All Projects' : 'Unassigned'}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-slate-600">
                            {role.access_level === 'admin' ? 'All locations' : `${user.visibility_scope || 'subtree'} • ${assignedCount} assigned`}
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
                    {roleProfiles.map((role) => {
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
                          <TableCell className="text-sm text-slate-600">{Array.isArray(role.permissions) ? role.permissions.length : 0} permissions</TableCell>
                          <TableCell>
                            <Badge variant={role.is_active === false ? 'secondary' : 'default'}>
                              {role.is_system ? 'System' : 'Custom'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditRole(role)}>
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
                <Select value={createForm.role} onValueChange={(value) => setCreateForm((current) => ({ ...current, role: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {roleProfiles.filter((role) => role.is_active !== false).map((role) => (
                      <SelectItem key={role.id} value={role.role_key}>{role.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(roleMap[createForm.role]?.access_level || 'user') !== 'admin' ? (
              <>
                <div>
                  <Label className="mb-1.5 block">Primary Project</Label>
                  <Select value={createForm.site_id || 'none'} onValueChange={(value) => setCreateForm((current) => ({ ...current, site_id: value === 'none' ? '' : value }))}>
                    <SelectTrigger><SelectValue placeholder="Select primary project" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No primary project</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 flex items-center gap-2">
                    <Network className="w-4 h-4 text-slate-500" /> Project Access
                  </Label>
                  <SiteAccessChecklist
                    roots={roots}
                    childMap={childMap}
                    selectedIds={createForm.allowed_site_ids}
                    onToggle={(siteId, checked) => toggleSelectedSite(setCreateForm, createForm.allowed_site_ids, siteId, checked)}
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block">Visibility Scope</Label>
                  <Select value={createForm.visibility_scope} onValueChange={(value) => setCreateForm((current) => ({ ...current, visibility_scope: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="assigned_only">Assigned Projects Only</SelectItem>
                      <SelectItem value="subtree">Assigned Projects and Children</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}

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
                <Select value={editForm.role} onValueChange={(value) => setEditForm((current) => ({ ...current, role: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {roleProfiles.filter((role) => role.is_active !== false).map((role) => (
                      <SelectItem key={role.id} value={role.role_key}>{role.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(roleMap[editForm.role]?.access_level || 'user') !== 'admin' ? (
              <>
                <div>
                  <Label className="mb-1.5 block">Primary Project</Label>
                  <Select value={editForm.site_id || 'none'} onValueChange={(value) => setEditForm((current) => ({ ...current, site_id: value === 'none' ? '' : value }))}>
                    <SelectTrigger><SelectValue placeholder="Select primary project" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No primary project</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 flex items-center gap-2">
                    <Network className="w-4 h-4 text-slate-500" /> Project Access
                  </Label>
                  <SiteAccessChecklist
                    roots={roots}
                    childMap={childMap}
                    selectedIds={editForm.allowed_site_ids}
                    onToggle={(siteId, checked) => toggleSelectedSite(setEditForm, editForm.allowed_site_ids, siteId, checked)}
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block">Visibility Scope</Label>
                  <Select value={editForm.visibility_scope} onValueChange={(value) => setEditForm((current) => ({ ...current, visibility_scope: value }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="assigned_only">Assigned Projects Only</SelectItem>
                      <SelectItem value="subtree">Assigned Projects and Children</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}

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

            <PermissionChecklist selected={roleForm.permissions} onToggle={(permission, checked) => togglePermission(setRoleForm, roleForm.permissions, permission, checked)} />

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

            <PermissionChecklist selected={editRoleForm.permissions} onToggle={(permission, checked) => togglePermission(setEditRoleForm, editRoleForm.permissions, permission, checked)} />

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
