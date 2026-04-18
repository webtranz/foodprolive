import React, { useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Upload, Trash2, Users, Download, Pencil, FileSpreadsheet, AlertCircle } from 'lucide-react';

const CAT_COLORS = {
  labor: 'bg-blue-100 text-blue-800',
  junior: 'bg-purple-100 text-purple-800',
  senior: 'bg-amber-100 text-amber-800',
  other: 'bg-slate-100 text-slate-600'
};

export default function UserGroupManager() {
  const [showCreate, setShowCreate] = useState(false);
  const [editGroup, setEditGroup] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', members: [] });
  const [newMember, setNewMember] = useState({ name: '', email: '', phone: '', category: 'labor' });
  const [bulkError, setBulkError] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const [showBulkPreview, setShowBulkPreview] = useState(false);
  const fileRef = useRef(null);
  const queryClient = useQueryClient();

  const { data: groups = [] } = useQuery({
    queryKey: ['userGroups'],
    queryFn: () => base44.entities.UserGroup.list('-created_date', 100)
  });

  const createMutation = useMutation({
    mutationFn: (data) => {
      const counts = data.members.reduce((acc, m) => {
        acc[m.category] = (acc[m.category] || 0) + 1;
        return acc;
      }, {});
      return base44.entities.UserGroup.create({
        ...data,
        total_members: data.members.length,
        labor_count: counts.labor || 0,
        junior_count: counts.junior || 0,
        senior_count: counts.senior || 0
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userGroups'] });
      setShowCreate(false);
      setEditGroup(null);
      setForm({ name: '', description: '', members: [] });
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => {
      const counts = data.members.reduce((acc, m) => {
        acc[m.category] = (acc[m.category] || 0) + 1;
        return acc;
      }, {});
      return base44.entities.UserGroup.update(id, {
        ...data,
        total_members: data.members.length,
        labor_count: counts.labor || 0,
        junior_count: counts.junior || 0,
        senior_count: counts.senior || 0
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userGroups'] });
      setShowCreate(false);
      setEditGroup(null);
      setForm({ name: '', description: '', members: [] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.UserGroup.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['userGroups'] })
  });

  const addMember = () => {
    if (!newMember.name) return;
    const uid = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setForm(f => ({ ...f, members: [...f.members, { ...newMember, user_id: uid }] }));
    setNewMember({ name: '', email: '', phone: '', category: 'labor' });
  };

  const removeMember = (idx) => setForm(f => ({ ...f, members: f.members.filter((_, i) => i !== idx) }));

  const openEdit = (group) => {
    setEditGroup(group);
    setForm({ name: group.name, description: group.description || '', members: group.members || [] });
    setShowCreate(true);
  };

  const handleSubmit = () => {
    if (editGroup) {
      updateMutation.mutate({ id: editGroup.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  };

  // Parse uploaded CSV/Excel
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setBulkError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) { setBulkError('File must have a header row and at least one data row'); return; }
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      const nameIdx = headers.findIndex(h => h.includes('name'));
      const emailIdx = headers.findIndex(h => h.includes('email'));
      const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile'));
      const catIdx = headers.findIndex(h => h.includes('category') || h.includes('cat') || h.includes('type'));

      if (nameIdx === -1) { setBulkError('CSV must have a "name" column'); return; }

      const parsed = lines.slice(1).map((line, i) => {
        const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        const rawCat = (catIdx >= 0 ? cols[catIdx] : '').toLowerCase();
        const category = ['labor', 'junior', 'senior'].includes(rawCat) ? rawCat : 'labor';
        return {
          user_id: `usr_${Date.now()}_${i}`,
          name: cols[nameIdx] || '',
          email: emailIdx >= 0 ? cols[emailIdx] : '',
          phone: phoneIdx >= 0 ? cols[phoneIdx] : '',
          category
        };
      }).filter(m => m.name);

      if (parsed.length === 0) { setBulkError('No valid members found in file'); return; }
      setBulkPreview(parsed);
      setShowBulkPreview(true);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const confirmBulkImport = () => {
    setForm(f => ({ ...f, members: [...f.members, ...bulkPreview] }));
    setBulkPreview([]);
    setShowBulkPreview(false);
  };

  const downloadTemplate = () => {
    const csv = 'name,email,phone,category\nJohn Doe,john@example.com,+1234567890,labor\nJane Smith,jane@example.com,+0987654321,junior\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'user_group_template.csv'; a.click();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">User Groups</h2>
        <Button onClick={() => { setEditGroup(null); setForm({ name: '', description: '', members: [] }); setShowCreate(true); }} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="w-4 h-4 mr-2" /> Create Group
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {groups.map(group => (
          <Card key={group.id} className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle className="text-base">{group.name}</CardTitle>
                  {group.description && <p className="text-xs text-slate-500 mt-0.5">{group.description}</p>}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(group)}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => deleteMutation.mutate(group.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 mb-3">
                <Users className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium">{group.total_members || 0} members</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {group.labor_count > 0 && <Badge className="bg-blue-100 text-blue-800 text-xs">Labor: {group.labor_count}</Badge>}
                {group.junior_count > 0 && <Badge className="bg-purple-100 text-purple-800 text-xs">Junior: {group.junior_count}</Badge>}
                {group.senior_count > 0 && <Badge className="bg-amber-100 text-amber-800 text-xs">Senior: {group.senior_count}</Badge>}
              </div>
            </CardContent>
          </Card>
        ))}
        {groups.length === 0 && (
          <div className="col-span-full text-center py-12 text-slate-400">
            <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>No user groups yet. Create one to get started.</p>
          </div>
        )}
      </div>

      {/* Create/Edit Group Dialog */}
      <Dialog open={showCreate} onOpenChange={(v) => { setShowCreate(v); if (!v) setEditGroup(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editGroup ? 'Edit Group' : 'Create User Group'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Group Name *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g., Block A Workers" className="mt-1" />
              </div>
              <div>
                <Label>Description</Label>
                <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1" />
              </div>
            </div>

            <Tabs defaultValue="manual">
              <TabsList>
                <TabsTrigger value="manual">Add Manually</TabsTrigger>
                <TabsTrigger value="bulk">Bulk Upload (CSV)</TabsTrigger>
              </TabsList>

              <TabsContent value="manual" className="space-y-3 pt-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Input value={newMember.name} onChange={e => setNewMember(m => ({ ...m, name: e.target.value }))} placeholder="Full Name *" />
                  <Input value={newMember.email} onChange={e => setNewMember(m => ({ ...m, email: e.target.value }))} placeholder="Email" />
                  <Input value={newMember.phone} onChange={e => setNewMember(m => ({ ...m, phone: e.target.value }))} placeholder="Phone" />
                  <Select value={newMember.category} onValueChange={v => setNewMember(m => ({ ...m, category: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="labor">Labor</SelectItem>
                      <SelectItem value="junior">Junior</SelectItem>
                      <SelectItem value="senior">Senior</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" size="sm" onClick={addMember} disabled={!newMember.name}>
                  <Plus className="w-3 h-3 mr-1" /> Add Member
                </Button>
              </TabsContent>

              <TabsContent value="bulk" className="space-y-3 pt-2">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium text-blue-800 flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4" /> CSV/Excel Bulk Upload
                  </p>
                  <p className="text-xs text-blue-700">Upload a CSV file with columns: <code>name, email, phone, category</code></p>
                  <p className="text-xs text-blue-600">Category must be: labor, junior, or senior</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={downloadTemplate}>
                      <Download className="w-3 h-3 mr-1" /> Download Template
                    </Button>
                    <Button size="sm" onClick={() => fileRef.current?.click()} className="bg-blue-600 hover:bg-blue-700">
                      <Upload className="w-3 h-3 mr-1" /> Upload CSV
                    </Button>
                  </div>
                  {bulkError && (
                    <div className="flex items-center gap-2 text-red-600 text-xs">
                      <AlertCircle className="w-3 h-3" /> {bulkError}
                    </div>
                  )}
                  <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFileUpload} />
                </div>
              </TabsContent>
            </Tabs>

            {/* Member List */}
            {form.members.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-slate-50 px-4 py-2 flex justify-between items-center">
                  <span className="text-sm font-medium">{form.members.length} Members</span>
                  <div className="flex gap-1 text-xs">
                    {['labor', 'junior', 'senior'].map(cat => {
                      const count = form.members.filter(m => m.category === cat).length;
                      return count > 0 ? <Badge key={cat} className={CAT_COLORS[cat]}>{cat}: {count}</Badge> : null;
                    })}
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {form.members.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{m.name}</TableCell>
                          <TableCell className="text-xs text-slate-500">{m.email || '-'}</TableCell>
                          <TableCell className="text-xs text-slate-500">{m.phone || '-'}</TableCell>
                          <TableCell><Badge className={CAT_COLORS[m.category]}>{m.category}</Badge></TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500" onClick={() => removeMember(i)}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setEditGroup(null); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={!form.name || (createMutation.isPending || updateMutation.isPending)} className="bg-indigo-600 hover:bg-indigo-700">
              {editGroup ? 'Update Group' : 'Create Group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Preview Dialog */}
      <Dialog open={showBulkPreview} onOpenChange={setShowBulkPreview}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Preview Bulk Upload ({bulkPreview.length} members)</DialogTitle></DialogHeader>
          <div className="max-h-80 overflow-y-auto border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Category</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkPreview.slice(0, 50).map((m, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{m.name}</TableCell>
                    <TableCell className="text-xs">{m.email || '-'}</TableCell>
                    <TableCell><Badge className={CAT_COLORS[m.category]}>{m.category}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {bulkPreview.length > 50 && <p className="text-xs text-center text-slate-400 py-2">...and {bulkPreview.length - 50} more</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkPreview(false)}>Cancel</Button>
            <Button onClick={confirmBulkImport} className="bg-green-600 hover:bg-green-700">
              Import {bulkPreview.length} Members
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}