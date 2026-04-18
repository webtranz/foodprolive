import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import PageHeader from '@/components/ui/PageHeader';
import { usePermissions } from '@/components/auth/usePermissions';
import { Shield, User, Briefcase, ShieldAlert, UserPlus, Mail, Pencil, Building2, CheckCircle2 } from 'lucide-react';

const ROLE_CONFIG = {
  admin: {
    label: 'Administrator',
    color: 'bg-red-100 text-red-800 border-red-200',
    icon: Shield,
    description: 'Full access — manage users, sessions, reports, and all modules',
    permissions: ['Scan QR', 'Dashboard', 'Reports', 'Create Sessions', 'Manage Sessions', 'Manage Groups', 'Manage Users', 'Delete Records', 'Export Data'],
  },
  manager: {
    label: 'Manager',
    color: 'bg-amber-100 text-amber-800 border-amber-200',
    icon: Briefcase,
    description: 'Can create sessions, manage groups, view reports — cannot manage users',
    permissions: ['Scan QR', 'Dashboard', 'Reports', 'Create Sessions', 'Manage Sessions', 'Manage Groups', 'Export Data'],
  },
  user: {
    label: 'Regular User',
    color: 'bg-blue-100 text-blue-800 border-blue-200',
    icon: User,
    description: 'Can scan QR codes and view the attendance dashboard only',
    permissions: ['Scan QR', 'Dashboard'],
  },
};

export default function UserRoleManagement() {
  const { can, isAdmin, loading: permLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [savingId, setSavingId] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [deleteUser, setDeleteUser] = useState(null);
  const [inviteSent, setInviteSent] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'user', site_id: '' });
  const [editForm, setEditForm] = useState({ role: 'user', site_id: '' });

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list(),
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list(),
  });

  const inviteMutation = useMutation({
    mutationFn: async ({ email, role, site_id }) => {
      const invited = await base44.users.inviteUser(email, role);
      // If site assigned, update the newly created user's site after a short delay
      if (site_id) {
        const newUsers = await base44.entities.User.list();
        const newUser = newUsers.find(u => u.email === email);
        if (newUser) {
          const site = sites.find(s => s.id === site_id);
          await base44.entities.User.update(newUser.id, { site_id, site_name: site?.name || '' });
        }
      }
      return invited;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setInviteSent(true);
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.User.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditOpen(false);
      setEditingUser(null);
      setSavingId(null);
    },
    onSettled: () => setSavingId(null),
  });

  const openInvite = () => {
    setInviteForm({ email: '', role: 'user', site_id: '' });
    setInviteSent(false);
    setInviteOpen(true);
  };

  const openEdit = (user) => {
    setEditingUser(user);
    setEditForm({ role: user.role || 'user', site_id: user.site_id || '' });
    setEditOpen(true);
  };

  const handleInviteSubmit = (e) => {
    e.preventDefault();
    inviteMutation.mutate(inviteForm);
  };

  const handleEditSubmit = (e) => {
    e.preventDefault();
    const site = sites.find(s => s.id === editForm.site_id);
    updateUserMutation.mutate({
      id: editingUser.id,
      data: {
        role: editForm.role,
        site_id: editForm.site_id || null,
        site_name: site?.name || null,
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
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="User Management"
          description="Invite users, assign roles and sites to control access"
        >
          <Button onClick={openInvite} className="bg-emerald-600 hover:bg-emerald-700">
            <UserPlus className="w-4 h-4 mr-2" /> Invite User
          </Button>
        </PageHeader>

        {/* Role Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(ROLE_CONFIG).map(([roleKey, cfg]) => {
            const Icon = cfg.icon;
            const count = users.filter(u => (u.role || 'user') === roleKey).length;
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
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {cfg.permissions.map(p => (
                      <Badge key={p} variant="secondary" className="text-xs">{p}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* User List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5" /> All Users ({users.length})
              </CardTitle>
              <Button onClick={openInvite} size="sm" className="bg-emerald-600 hover:bg-emerald-700">
                <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Invite
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Assigned Site</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(user => {
                  const roleKey = user.role || 'user';
                  const cfg = ROLE_CONFIG[roleKey] || ROLE_CONFIG.user;
                  const Icon = cfg.icon;
                  return (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.full_name || '—'}</TableCell>
                      <TableCell className="text-sm text-slate-600">{user.email}</TableCell>
                      <TableCell>
                        <Badge className={`${cfg.color} flex items-center gap-1 w-fit`}>
                          <Icon className="w-3 h-3" />{cfg.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {user.site_name ? (
                          <Badge variant="outline" className="flex items-center gap-1 w-fit">
                            <Building2 className="w-3 h-3" />{user.site_name}
                          </Badge>
                        ) : (
                          <span className="text-slate-400 text-xs">{roleKey === 'admin' ? 'All Sites' : 'Unassigned'}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7"
                            onClick={() => openEdit(user)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-slate-400">No users found</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Invite User Dialog */}
      <Dialog open={inviteOpen} onOpenChange={(o) => { if (!o) { setInviteOpen(false); setInviteSent(false); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-emerald-600" /> Invite New User
            </DialogTitle>
          </DialogHeader>

          {inviteSent ? (
            <div className="text-center py-6">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-800">Invitation Sent!</h3>
              <p className="text-sm text-slate-500 mt-1">
                An invitation email has been sent to <strong>{inviteForm.email}</strong>.<br />
                They will receive a link to set up their account.
              </p>
              <div className="mt-4 flex gap-2 justify-center">
                <Button variant="outline" onClick={() => { setInviteSent(false); setInviteForm({ email: '', role: 'user', site_id: '' }); }}>
                  Invite Another
                </Button>
                <Button onClick={() => setInviteOpen(false)} className="bg-emerald-600 hover:bg-emerald-700">Done</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleInviteSubmit} className="space-y-4">
              <div>
                <Label className="text-sm font-medium mb-1.5 block">Email Address <span className="text-red-500">*</span></Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    type="email"
                    required
                    value={inviteForm.email}
                    onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="user@example.com"
                    className="pl-9"
                  />
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium mb-1.5 block">Role <span className="text-red-500">*</span></Label>
                <Select value={inviteForm.role} onValueChange={v => setInviteForm(f => ({ ...f, role: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">
                      <div className="flex items-center gap-2"><Shield className="w-3.5 h-3.5 text-red-500" /> Administrator</div>
                    </SelectItem>
                    <SelectItem value="manager">
                      <div className="flex items-center gap-2"><Briefcase className="w-3.5 h-3.5 text-amber-500" /> Manager</div>
                    </SelectItem>
                    <SelectItem value="user">
                      <div className="flex items-center gap-2"><User className="w-3.5 h-3.5 text-blue-500" /> Regular User</div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-400 mt-1">{ROLE_CONFIG[inviteForm.role]?.description}</p>
              </div>

              {inviteForm.role !== 'admin' && (
                <div>
                  <Label className="text-sm font-medium mb-1.5 block">Assign to Site</Label>
                  <Select value={inviteForm.site_id || 'none'} onValueChange={v => setInviteForm(f => ({ ...f, site_id: v === 'none' ? '' : v }))}>
                    <SelectTrigger><SelectValue placeholder="Select a site (optional)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No specific site</SelectItem>
                      {sites.map(s => (
                        <SelectItem key={s.id} value={s.id}>
                          <div className="flex items-center gap-2">
                            <Building2 className="w-3.5 h-3.5 text-slate-400" /> {s.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={inviteMutation.isPending}>
                  {inviteMutation.isPending ? 'Sending…' : 'Send Invitation'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-slate-600" /> Edit User — {editingUser?.full_name || editingUser?.email}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-600">
              <strong>Email:</strong> {editingUser?.email}
            </div>

            <div>
              <Label className="text-sm font-medium mb-1.5 block">Role</Label>
              <Select value={editForm.role} onValueChange={v => setEditForm(f => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Administrator</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="user">Regular User</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-400 mt-1">{ROLE_CONFIG[editForm.role]?.description}</p>
            </div>

            {editForm.role !== 'admin' && (
              <div>
                <Label className="text-sm font-medium mb-1.5 block">Assigned Site</Label>
                <Select value={editForm.site_id || 'none'} onValueChange={v => setEditForm(f => ({ ...f, site_id: v === 'none' ? '' : v }))}>
                  <SelectTrigger><SelectValue placeholder="No specific site" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No specific site</SelectItem>
                    {sites.map(s => (
                      <SelectItem key={s.id} value={s.id}>
                        <div className="flex items-center gap-2">
                          <Building2 className="w-3.5 h-3.5 text-slate-400" /> {s.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700"
                disabled={updateUserMutation.isPending}>
                {updateUserMutation.isPending ? 'Saving…' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
