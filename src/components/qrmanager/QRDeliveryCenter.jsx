import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Send, Users, Plus, Mail, MessageSquare, Calendar, CheckCircle2, Clock, XCircle, Trash2 } from 'lucide-react';
import { format } from 'date-fns';

export default function QRDeliveryCenter({ preselectedQR }) {
  const [showSendDialog, setShowSendDialog] = useState(!!preselectedQR);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [selectedQR, setSelectedQR] = useState(preselectedQR || null);
  const [sendForm, setSendForm] = useState({
    delivery_method: 'email',
    subject: 'Your QR Code',
    message: 'Please find your QR code attached. Scan to proceed.',
    scheduled_at: '',
    is_scheduled: false,
    manual_email: '',
    manual_phone: '',
    selected_groups: []
  });
  const [groupForm, setGroupForm] = useState({ name: '', description: '', members: [] });
  const [newMember, setNewMember] = useState({ name: '', email: '', phone: '', category: 'other' });

  const queryClient = useQueryClient();

  const { data: qrCodes = [] } = useQuery({ queryKey: ['qrCodes'], queryFn: () => base44.entities.QRCode.list() });
  const { data: groups = [] } = useQuery({ queryKey: ['userGroups'], queryFn: () => base44.entities.UserGroup.list() });
  const { data: deliveries = [] } = useQuery({ queryKey: ['qrDeliveries'], queryFn: () => base44.entities.QRDelivery.list('-created_date', 100) });

  const sendMutation = useMutation({
    mutationFn: async (data) => {
      // Collect all recipients
      const recipients = [];
      if (data.manual_email) recipients.push({ name: 'Manual', email: data.manual_email, status: 'pending' });
      if (data.manual_phone) recipients.push({ name: 'Manual', phone: data.manual_phone, status: 'pending' });
      data.selected_groups.forEach(gid => {
        const group = groups.find(g => g.id === gid);
        group?.members?.forEach(m => recipients.push({ ...m, status: 'pending' }));
      });

      const delivery = await base44.entities.QRDelivery.create({
        qr_code_id: selectedQR.id,
        qr_code_title: selectedQR.title,
        qr_token: selectedQR.token,
        delivery_method: data.delivery_method,
        subject: data.subject,
        message: data.message,
        recipients,
        group_ids: data.selected_groups,
        scheduled_at: data.is_scheduled ? data.scheduled_at : null,
        status: data.is_scheduled ? 'scheduled' : 'sending',
        sent_count: 0,
        failed_count: 0
      });

      // If not scheduled, send emails now
      if (!data.is_scheduled && data.delivery_method !== 'sms') {
        const emailRecipients = recipients.filter(r => r.email);
        let sentCount = 0;
        for (const recipient of emailRecipients) {
          await base44.integrations.Core.SendEmail({
            to: recipient.email,
            subject: data.subject,
            body: `${data.message}\n\nYour QR Code Token: ${selectedQR.token}\n\nQR Title: ${selectedQR.title}`
          });
          sentCount++;
        }
        await base44.entities.QRDelivery.update(delivery.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_count: sentCount
        });
      }
      return delivery;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['qrDeliveries'] });
      setShowSendDialog(false);
      setSendForm({ delivery_method: 'email', subject: 'Your QR Code', message: 'Please find your QR code attached. Scan to proceed.', scheduled_at: '', is_scheduled: false, manual_email: '', manual_phone: '', selected_groups: [] });
    }
  });

  const createGroupMutation = useMutation({
    mutationFn: (data) => base44.entities.UserGroup.create({ ...data, total_members: data.members.length }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userGroups'] });
      setShowGroupDialog(false);
      setGroupForm({ name: '', description: '', members: [] });
    }
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (id) => base44.entities.UserGroup.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['userGroups'] })
  });

  const addMember = () => {
    if (newMember.name && (newMember.email || newMember.phone)) {
      setGroupForm({ ...groupForm, members: [...groupForm.members, { ...newMember }] });
      setNewMember({ name: '', email: '', phone: '', category: 'other' });
    }
  };

  const toggleGroup = (gid) => {
    const sel = sendForm.selected_groups;
    setSendForm({ ...sendForm, selected_groups: sel.includes(gid) ? sel.filter(g => g !== gid) : [...sel, gid] });
  };

  const STATUS_ICON = { sent: CheckCircle2, scheduled: Clock, failed: XCircle, sending: Clock, partial: CheckCircle2 };
  const STATUS_STYLE = { sent: 'text-green-600', scheduled: 'text-blue-600', failed: 'text-red-600', sending: 'text-amber-600', partial: 'text-amber-600', draft: 'text-slate-500' };

  return (
    <div className="space-y-6">
      <Tabs defaultValue="deliveries">
        <TabsList>
          <TabsTrigger value="deliveries">Delivery History</TabsTrigger>
          <TabsTrigger value="groups">User Groups</TabsTrigger>
        </TabsList>

        <TabsContent value="deliveries" className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Send QR Codes</h3>
            <Button onClick={() => setShowSendDialog(true)} className="bg-emerald-600 hover:bg-emerald-700">
              <Send className="w-4 h-4 mr-2" /> Send QR Code
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>QR Code</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Recipients</TableHead>
                    <TableHead>Scheduled / Sent</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map(d => {
                    const Icon = STATUS_ICON[d.status] || Clock;
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.qr_code_title}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {d.delivery_method === 'email' ? <Mail className="w-3 h-3 mr-1 inline" /> : <MessageSquare className="w-3 h-3 mr-1 inline" />}
                            {d.delivery_method}
                          </Badge>
                        </TableCell>
                        <TableCell>{d.recipients?.length || 0} recipients</TableCell>
                        <TableCell className="text-sm text-slate-500">
                          {d.scheduled_at ? format(new Date(d.scheduled_at), 'MMM d, HH:mm') :
                           d.sent_at ? format(new Date(d.sent_at), 'MMM d, HH:mm') : '-'}
                        </TableCell>
                        <TableCell>
                          <span className={`flex items-center gap-1 text-sm font-medium ${STATUS_STYLE[d.status]}`}>
                            <Icon className="w-4 h-4" /> {d.status}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {deliveries.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-slate-400">No deliveries yet</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="groups" className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">User Groups</h3>
            <Button onClick={() => setShowGroupDialog(true)} className="bg-indigo-600 hover:bg-indigo-700">
              <Plus className="w-4 h-4 mr-2" /> Create Group
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {groups.map(group => (
              <Card key={group.id}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-base">{group.name}</CardTitle>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => deleteGroupMutation.mutate(group.id)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                  {group.description && <p className="text-sm text-slate-500">{group.description}</p>}
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-400" />
                    <span className="text-sm">{group.total_members || 0} members</span>
                  </div>
                </CardContent>
              </Card>
            ))}
            {groups.length === 0 && <p className="col-span-full text-slate-400 text-sm">No user groups yet.</p>}
          </div>
        </TabsContent>
      </Tabs>

      {/* Send QR Dialog */}
      <Dialog open={showSendDialog} onOpenChange={setShowSendDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Send className="w-5 h-5" /> Send QR Code</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select QR Code</Label>
              <Select value={selectedQR?.id} onValueChange={v => setSelectedQR(qrCodes.find(q => q.id === v))}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Choose QR code" /></SelectTrigger>
                <SelectContent>{qrCodes.filter(q => q.status === 'active').map(q => <SelectItem key={q.id} value={q.id}>{q.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Delivery Method</Label>
                <Select value={sendForm.delivery_method} onValueChange={v => setSendForm({ ...sendForm, delivery_method: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">📧 Email</SelectItem>
                    <SelectItem value="sms">📱 SMS</SelectItem>
                    <SelectItem value="both">📧📱 Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Subject</Label>
                <Input value={sendForm.subject} onChange={e => setSendForm({ ...sendForm, subject: e.target.value })} className="mt-1" />
              </div>
            </div>

            <div>
              <Label>Message</Label>
              <Textarea value={sendForm.message} onChange={e => setSendForm({ ...sendForm, message: e.target.value })} rows={3} className="mt-1" />
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium">Add Individual Recipient</p>
              <div className="grid grid-cols-2 gap-2">
                <Input value={sendForm.manual_email} onChange={e => setSendForm({ ...sendForm, manual_email: e.target.value })} placeholder="Email address" />
                <Input value={sendForm.manual_phone} onChange={e => setSendForm({ ...sendForm, manual_phone: e.target.value })} placeholder="Phone number" />
              </div>
            </div>

            {groups.length > 0 && (
              <div className="border rounded-lg p-4 space-y-2">
                <p className="text-sm font-medium">Select Groups</p>
                {groups.map(g => (
                  <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={sendForm.selected_groups.includes(g.id)} onChange={() => toggleGroup(g.id)} className="rounded" />
                    <span className="text-sm">{g.name} ({g.total_members} members)</span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <Switch checked={sendForm.is_scheduled} onCheckedChange={v => setSendForm({ ...sendForm, is_scheduled: v })} />
              <div className="flex-1">
                <p className="text-sm font-medium">Schedule Delivery</p>
                {sendForm.is_scheduled && (
                  <Input type="datetime-local" value={sendForm.scheduled_at} onChange={e => setSendForm({ ...sendForm, scheduled_at: e.target.value })} className="mt-2" />
                )}
              </div>
              <Calendar className="w-4 h-4 text-blue-600" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendDialog(false)}>Cancel</Button>
            <Button onClick={() => sendMutation.mutate(sendForm)} disabled={!selectedQR || sendMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
              {sendMutation.isPending ? 'Sending...' : sendForm.is_scheduled ? <><Calendar className="w-4 h-4 mr-2" />Schedule</> : <><Send className="w-4 h-4 mr-2" />Send Now</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Group Dialog */}
      <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create User Group</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Group Name *</Label>
              <Input value={groupForm.name} onChange={e => setGroupForm({ ...groupForm, name: e.target.value })} placeholder="e.g., Kitchen Staff, Management" className="mt-1" />
            </div>
            <div>
              <Label>Description</Label>
              <Input value={groupForm.description} onChange={e => setGroupForm({ ...groupForm, description: e.target.value })} className="mt-1" />
            </div>
            <div className="border rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium">Add Members</p>
              <div className="grid grid-cols-2 gap-2">
                <Input value={newMember.name} onChange={e => setNewMember({ ...newMember, name: e.target.value })} placeholder="Name" />
                <Select value={newMember.category} onValueChange={v => setNewMember({ ...newMember, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="labor">Labor</SelectItem>
                    <SelectItem value="junior">Junior</SelectItem>
                    <SelectItem value="senior">Senior</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                <Input value={newMember.email} onChange={e => setNewMember({ ...newMember, email: e.target.value })} placeholder="Email" />
                <Input value={newMember.phone} onChange={e => setNewMember({ ...newMember, phone: e.target.value })} placeholder="Phone" />
              </div>
              <Button variant="outline" size="sm" onClick={addMember} disabled={!newMember.name}>
                <Plus className="w-3 h-3 mr-1" /> Add Member
              </Button>
            </div>
            {groupForm.members.length > 0 && (
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {groupForm.members.map((m, i) => (
                  <div key={i} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded text-sm">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-slate-500">{m.email || m.phone}</span>
                    <Badge variant="outline" className="capitalize">{m.category}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGroupDialog(false)}>Cancel</Button>
            <Button onClick={() => createGroupMutation.mutate(groupForm)} disabled={!groupForm.name || createGroupMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700">
              Create Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}