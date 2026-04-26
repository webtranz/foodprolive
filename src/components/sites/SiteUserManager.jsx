import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, UserPlus, Building2, X, Network } from 'lucide-react';

export default function SiteUserManager({ site, onClose }) {
  const queryClient = useQueryClient();

  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list()
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const siteUsers = allUsers.filter((user) => user.site_id === site.id || (Array.isArray(user.allowed_site_ids) && user.allowed_site_ids.includes(site.id)));
  const unassignedUsers = allUsers.filter((user) => !user.site_id && user.role !== 'admin');

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, data }) => base44.entities.User.update(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    }
  });

  const assignUser = (userId, role = 'user') => {
    const existing = allUsers.find((user) => user.id === userId);
    const allowed = Array.isArray(existing?.allowed_site_ids) ? existing.allowed_site_ids : [];
    updateUserMutation.mutate({
      userId,
      data: {
        role,
        site_id: existing?.site_id || site.id,
        site_name: existing?.site_name || site.name,
        allowed_site_ids: Array.from(new Set([site.id, ...allowed]))
      }
    });
  };

  const removeFromSite = (userId) => {
    const existing = allUsers.find((user) => user.id === userId);
    const remaining = (Array.isArray(existing?.allowed_site_ids) ? existing.allowed_site_ids : []).filter((id) => id !== site.id);
    const nextPrimary = existing?.site_id === site.id ? remaining[0] || null : existing?.site_id;
    const nextSite = sites.find((entry) => entry.id === nextPrimary);
    updateUserMutation.mutate({
      userId,
      data: {
        site_id: nextPrimary,
        site_name: nextSite?.name || null,
        allowed_site_ids: remaining
      }
    });
  };

  const updateRole = (userId, role) => {
    updateUserMutation.mutate({ userId, data: { role } });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-emerald-600" />
            Manage Users - {site.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <Users className="w-4 h-4" /> Location Users ({siteUsers.length})
            </h3>
          </div>

          {siteUsers.length === 0 ? (
            <div className="text-center py-6 bg-slate-50 rounded-xl text-slate-400 text-sm">
              No users assigned to this location yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.full_name || '-'}</TableCell>
                    <TableCell className="text-sm text-slate-500">{user.email}</TableCell>
                    <TableCell>
                      <Select value={user.role || 'user'} onValueChange={(role) => updateRole(user.id, role)}>
                        <SelectTrigger className="h-7 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manager">Manager</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {Array.isArray(user.allowed_site_ids) ? `${user.allowed_site_ids.length} locations` : '1 location'}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => removeFromSite(user.id)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {unassignedUsers.length > 0 ? (
            <div className="border-t pt-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
                <UserPlus className="w-4 h-4" /> Assign Users to This Location
              </h3>
              <div className="space-y-2">
                {unassignedUsers.map((user) => (
                  <div key={user.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{user.full_name || user.email}</p>
                      <p className="text-xs text-slate-400">{user.email}</p>
                    </div>
                    <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 h-8 text-xs" onClick={() => assignUser(user.id, user.role || 'user')}>
                      Assign
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4" />
              This panel manages location assignment as part of each user&apos;s allowed location access list.
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
