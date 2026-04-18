import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, UserPlus, Building2, X } from 'lucide-react';

const ROLE_COLORS = {
  admin: 'bg-red-100 text-red-700',
  manager: 'bg-amber-100 text-amber-700',
  user: 'bg-blue-100 text-blue-700'
};

export default function SiteUserManager({ site, onClose }) {
  const [editingUser, setEditingUser] = useState(null);
  const [newRole, setNewRole] = useState('user');
  const queryClient = useQueryClient();

  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const siteUsers = allUsers.filter(u => u.site_id === site.id);
  const unassignedUsers = allUsers.filter(u => !u.site_id && u.role !== 'admin');

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, data }) => base44.auth.updateMe
      ? base44.entities.User.update(userId, data)
      : base44.entities.User.update(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditingUser(null);
    }
  });

  const assignUser = (userId, role = 'user') => {
    updateUserMutation.mutate({
      userId,
      data: { site_id: site.id, site_name: site.name, role }
    });
  };

  const removeFromSite = (userId) => {
    updateUserMutation.mutate({
      userId,
      data: { site_id: null, site_name: null }
    });
  };

  const updateRole = (userId, role) => {
    updateUserMutation.mutate({ userId, data: { role } });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-emerald-600" />
            Manage Users — {site.name}
          </DialogTitle>
        </DialogHeader>

        {/* Current Site Users */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <Users className="w-4 h-4" /> Site Users ({siteUsers.length})
            </h3>
          </div>

          {siteUsers.length === 0 ? (
            <div className="text-center py-6 bg-slate-50 rounded-xl text-slate-400 text-sm">
              No users assigned to this site yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteUsers.map(user => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.full_name || '—'}</TableCell>
                    <TableCell className="text-sm text-slate-500">{user.email}</TableCell>
                    <TableCell>
                      <Select value={user.role || 'user'} onValueChange={role => updateRole(user.id, role)}>
                        <SelectTrigger className="h-7 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manager">Manager</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500"
                        onClick={() => removeFromSite(user.id)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Assign Unassigned Users */}
          {unassignedUsers.length > 0 && (
            <div className="border-t pt-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
                <UserPlus className="w-4 h-4" /> Assign Users to This Site
              </h3>
              <div className="space-y-2">
                {unassignedUsers.map(user => (
                  <div key={user.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{user.full_name || user.email}</p>
                      <p className="text-xs text-slate-400">{user.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select defaultValue="user" onValueChange={v => setNewRole(v)}>
                        <SelectTrigger className="h-8 w-24 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manager">Manager</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 h-8 text-xs"
                        onClick={() => assignUser(user.id, newRole)}>
                        Assign
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Users assigned to other sites */}
          {allUsers.filter(u => u.site_id && u.site_id !== site.id && u.role !== 'admin').length > 0 && (
            <div className="border-t pt-4">
              <p className="text-xs text-slate-400 font-medium mb-2">Users Assigned to Other Sites</p>
              <div className="space-y-1">
                {allUsers.filter(u => u.site_id && u.site_id !== site.id && u.role !== 'admin').map(user => {
                  const otherSite = sites.find(s => s.id === user.site_id);
                  return (
                    <div key={user.id} className="flex items-center justify-between p-2.5 bg-slate-50 rounded-lg opacity-60">
                      <div>
                        <p className="text-sm">{user.full_name || user.email}</p>
                        <p className="text-xs text-slate-400">→ {otherSite?.name || user.site_name}</p>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 text-xs"
                        onClick={() => assignUser(user.id, user.role || 'user')}>
                        Move Here
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}