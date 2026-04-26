import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import PageHeader from '@/components/ui/PageHeader';
import { usePermissions } from '@/components/auth/usePermissions';
import { Shield, User, Briefcase, ShieldAlert, UserPlus, Mail, Pencil, Building2, KeyRound, Network } from 'lucide-react';

const ROLE_CONFIG = {
  admin: {
    label: 'Administrator',
    color: 'bg-red-100 text-red-800 border-red-200',
    icon: Shield,
    description: 'Full cross-location access with central administration controls'
  },
  manager: {
    label: 'Manager',
    color: 'bg-amber-100 text-amber-800 border-amber-200',
    icon: Briefcase,
    description: 'Operational access for assigned locations and reporting'
  },
  user: {
    label: 'Regular User',
    color: 'bg-blue-100 text-blue-800 border-blue-200',
    icon: User,
    description: 'Daily operations access limited to assigned locations'
  }
};

const emptyCreateForm = {
  full_name: '',
  email: '',
  password: '',
  role: 'user',
  site_id: '',
  allowed_site_ids: [],
  visibility_scope: 'subtree'
};

const emptyEditForm = {
  full_name: '',
  role: 'user',
  site_id: '',
  password: '',
  allowed_site_ids: [],
  visibility_scope: 'subtree'
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

export default function UserRoleManagement() {
  const { can, loading: permLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [createError, setCreateError] = useState('');
  const [editError, setEditError] = useState('');
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [editForm, setEditForm] = useState(emptyEditForm);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const adminUsers = useMemo(() => users.filter((user) => (user.role || 'user') === 'admin'), [users]);
  const roots = useMemo(() => sites.filter((site) => !site.parent_site_id), [sites]);
  const childMap = useMemo(() => buildChildMap(sites), [sites]);

  const createUserMutation = useMutation({
    mutationFn: async (payload) => {
      const primarySite = sites.find((site) => site.id === payload.site_id);
      const allowedSiteIds = Array.from(new Set([payload.site_id, ...(payload.allowed_site_ids || [])].filter(Boolean)));
      return base44.entities.User.create({
        full_name: payload.full_name.trim(),
        email: payload.email.trim().toLowerCase(),
        password: payload.password,
        role: payload.role,
        status: 'active',
        site_id: payload.role === 'admin' ? null : (payload.site_id || null),
        site_name: payload.role === 'admin' ? null : (primarySite?.name || null),
        allowed_site_ids: payload.role === 'admin' ? [] : allowedSiteIds,
        visibility_scope: payload.role === 'admin' ? 'all_locations' : payload.visibility_scope
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateOpen(false);
      setCreateError('');
      setCreateForm(emptyCreateForm);
    },
    onError: (error) => {
      setCreateError(error.message || 'Failed to create user');
    }
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.User.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditOpen(false);
      setEditingUser(null);
      setEditError('');
      setEditForm(emptyEditForm);
    },
    onError: (error) => {
      setEditError(error.message || 'Failed to update user');
    }
  });

  const toggleSelectedSite = (setter, selectedIds, siteId, checked) => {
    setter((current) => ({
      ...current,
      allowed_site_ids: checked
        ? Array.from(new Set([...(selectedIds || []), siteId]))
        : (selectedIds || []).filter((id) => id !== siteId),
      site_id: current.site_id || siteId
    }));
  };

  const openEdit = (user) => {
    setEditingUser(user);
    setEditForm({
      full_name: user.full_name || '',
      role: user.role || 'user',
      site_id: user.site_id || '',
      password: '',
      allowed_site_ids: Array.isArray(user.allowed_site_ids) ? user.allowed_site_ids : (user.site_id ? [user.site_id] : []),
      visibility_scope: user.visibility_scope || 'subtree'
    });
    setEditError('');
    setEditOpen(true);
  };

  const handleCreateSubmit = (event) => {
    event.preventDefault();
    setCreateError('');

    if (!createForm.full_name.trim()) {
      setCreateError('Full name is required');
      return;
    }

    if (createForm.password.trim().length < 8) {
      setCreateError('Password must be at least 8 characters long');
      return;
    }

    createUserMutation.mutate(createForm);
  };

  const handleEditSubmit = (event) => {
    event.preventDefault();
    setEditError('');

    if (!editingUser) return;
    if (!editForm.full_name.trim()) {
      setEditError('Full name is required');
      return;
    }
    if (adminUsers.length === 1 && editingUser.id === adminUsers[0].id && editForm.role !== 'admin') {
      setEditError('At least one administrator must remain in the system');
      return;
    }
    if (editForm.password && editForm.password.trim().length < 8) {
      setEditError('New password must be at least 8 characters long');
      return;
    }

    const primarySite = sites.find((site) => site.id === editForm.site_id);
    const allowedSiteIds = Array.from(new Set([editForm.site_id, ...(editForm.allowed_site_ids || [])].filter(Boolean)));

    updateUserMutation.mutate({
      id: editingUser.id,
      data: {
        full_name: editForm.full_name.trim(),
        role: editForm.role,
        site_id: editForm.role === 'admin' ? null : (editForm.site_id || null),
        site_name: editForm.role === 'admin' ? null : (primarySite?.name || null),
        allowed_site_ids: editForm.role === 'admin' ? [] : allowedSiteIds,
        visibility_scope: editForm.role === 'admin' ? 'all_locations' : editForm.visibility_scope,
        ...(editForm.password.trim() ? { password: editForm.password.trim() } : {})
      }
    });
  };

  if (permLoading || isLoading) return <div className="p-8 text-slate-500">Loading...</div>;

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
      <div className="max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="User Management"
          description="Assign primary locations, multi-location access, and visibility scope for each user"
        >
          <Button onClick={() => { setCreateForm(emptyCreateForm); setCreateError(''); setCreateOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
            <UserPlus className="w-4 h-4 mr-2" /> Create User
          </Button>
        </PageHeader>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(ROLE_CONFIG).map(([roleKey, cfg]) => {
            const Icon = cfg.icon;
            const count = users.filter((user) => (user.role || 'user') === roleKey).length;
            return (
              <Card key={roleKey} className="border-2 border-slate-100">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="w-5 h-5 text-slate-600" />
                      <CardTitle className="text-base">{cfg.label}</CardTitle>
                    </div>
                    <Badge className={cfg.color}>{count} users</Badge>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{cfg.description}</p>
                </CardHeader>
              </Card>
            );
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" /> Multi-Location Access Matrix
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Primary Location</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const roleKey = user.role || 'user';
                  const cfg = ROLE_CONFIG[roleKey] || ROLE_CONFIG.user;
                  const Icon = cfg.icon;
                  const assignedCount = Array.isArray(user.allowed_site_ids) ? user.allowed_site_ids.length : (user.site_id ? 1 : 0);
                  return (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.full_name || '-'}</TableCell>
                      <TableCell className="text-sm text-slate-600">{user.email}</TableCell>
                      <TableCell>
                        <Badge className={`${cfg.color} flex items-center gap-1 w-fit`}>
                          <Icon className="w-3 h-3" />{cfg.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.status === 'active' ? 'default' : 'secondary'}>
                          {user.status || 'active'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {user.site_name ? (
                          <Badge variant="outline" className="flex items-center gap-1 w-fit">
                            <Building2 className="w-3 h-3" />{user.site_name}
                          </Badge>
                        ) : (
                          <span className="text-slate-400 text-xs">{roleKey === 'admin' ? 'All Locations' : 'Unassigned'}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">
                        {roleKey === 'admin' ? 'All locations' : `${user.visibility_scope || 'subtree'} • ${assignedCount} assigned`}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(user)}>
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
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-emerald-600" /> Create New User
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateSubmit} className="space-y-4">
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
                  <Input type="password" className="pl-9" value={createForm.password} onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))} required minLength={8} />
                </div>
              </div>
              <div>
                <Label className="mb-1.5 block">Role</Label>
                <Select value={createForm.role} onValueChange={(value) => setCreateForm((current) => ({ ...current, role: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Administrator</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="user">Regular User</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {createForm.role !== 'admin' ? (
              <>
                <div>
                  <Label className="mb-1.5 block">Primary Location</Label>
                  <Select value={createForm.site_id || 'none'} onValueChange={(value) => setCreateForm((current) => ({ ...current, site_id: value === 'none' ? '' : value }))}>
                    <SelectTrigger><SelectValue placeholder="Select primary location" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No primary location</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 flex items-center gap-2">
                    <Network className="w-4 h-4 text-slate-500" />
                    Location Access
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
                      <SelectItem value="assigned_only">Assigned Locations Only</SelectItem>
                      <SelectItem value="subtree">Assigned Locations and Children</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}

            {createError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{createError}</div> : null}

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
              <Pencil className="w-5 h-5 text-slate-600" /> Edit User - {editingUser?.full_name || editingUser?.email}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4">
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
                    <SelectItem value="admin">Administrator</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="user">Regular User</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {editForm.role !== 'admin' ? (
              <>
                <div>
                  <Label className="mb-1.5 block">Primary Location</Label>
                  <Select value={editForm.site_id || 'none'} onValueChange={(value) => setEditForm((current) => ({ ...current, site_id: value === 'none' ? '' : value }))}>
                    <SelectTrigger><SelectValue placeholder="Select primary location" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No primary location</SelectItem>
                      {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 flex items-center gap-2">
                    <Network className="w-4 h-4 text-slate-500" />
                    Location Access
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
                      <SelectItem value="assigned_only">Assigned Locations Only</SelectItem>
                      <SelectItem value="subtree">Assigned Locations and Children</SelectItem>
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

            {editError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editError}</div> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={updateUserMutation.isPending}>
                {updateUserMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
