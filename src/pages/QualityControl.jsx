import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, XCircle, AlertTriangle, Thermometer, ClipboardCheck } from 'lucide-react';
import { format } from 'date-fns';

const HYGIENE_CHECKLIST_ITEMS = [
  'Equipment sanitization',
  'Staff hygiene compliance',
  'Work area cleanliness',
  'Storage temperature compliance',
  'Cross-contamination prevention',
  'Pest control verification'
];

const QUALITY_PARAMETERS = [
  'Visual appearance',
  'Texture consistency',
  'Aroma quality',
  'Taste profile',
  'Portion accuracy',
  'Packaging integrity'
];

const TEMPERATURE_STAGES = [
  { stage: 'cooking', min: 75, max: 85 },
  { stage: 'pasteurization', min: 63, max: 72 },
  { stage: 'cooling', min: 2, max: 8 },
  { stage: 'storage', min: 0, max: 5 }
];

export default function QualityControl() {
  const [showQCDialog, setShowQCDialog] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [qcForm, setQcForm] = useState({
    temperature_logs: [],
    hygiene_checklist: HYGIENE_CHECKLIST_ITEMS.map(item => ({ item, status: 'pass', notes: '' })),
    quality_checklist: QUALITY_PARAMETERS.map(param => ({ parameter: param, status: 'pass', value: '' })),
    approval_notes: ''
  });

  const queryClient = useQueryClient();

  const { data: batches = [] } = useQuery({
    queryKey: ['productionBatches'],
    queryFn: () => base44.entities.ProductionBatch.list('-production_date', 100)
  });

  const { data: qcRecords = [] } = useQuery({
    queryKey: ['qcRecords'],
    queryFn: () => base44.entities.QualityControl.list('-inspection_date', 100)
  });

  const createQCMutation = useMutation({
    mutationFn: (data) => base44.entities.QualityControl.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['qcRecords'] });
      queryClient.invalidateQueries({ queryKey: ['productionBatches'] });
      setShowQCDialog(false);
      resetForm();
    }
  });

  const updateBatchMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ProductionBatch.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productionBatches'] });
    }
  });

  const resetForm = () => {
    setSelectedBatch(null);
    setQcForm({
      temperature_logs: [],
      hygiene_checklist: HYGIENE_CHECKLIST_ITEMS.map(item => ({ item, status: 'pass', notes: '' })),
      quality_checklist: QUALITY_PARAMETERS.map(param => ({ parameter: param, status: 'pass', value: '' })),
      approval_notes: ''
    });
  };

  const startInspection = (batch) => {
    setSelectedBatch(batch);
    setQcForm({
      temperature_logs: TEMPERATURE_STAGES.map(s => ({
        stage: s.stage,
        temperature: 0,
        timestamp: new Date().toISOString(),
        meets_standard: false
      })),
      hygiene_checklist: HYGIENE_CHECKLIST_ITEMS.map(item => ({ item, status: 'pass', notes: '' })),
      quality_checklist: QUALITY_PARAMETERS.map(param => ({ parameter: param, status: 'pass', value: '' })),
      approval_notes: ''
    });
    setShowQCDialog(true);
  };

  const updateTemperature = (index, value) => {
    const logs = [...qcForm.temperature_logs];
    logs[index].temperature = parseFloat(value);
    const standard = TEMPERATURE_STAGES[index];
    logs[index].meets_standard = value >= standard.min && value <= standard.max;
    setQcForm({ ...qcForm, temperature_logs: logs });
  };

  const updateHygieneItem = (index, field, value) => {
    const checklist = [...qcForm.hygiene_checklist];
    checklist[index][field] = value;
    setQcForm({ ...qcForm, hygiene_checklist: checklist });
  };

  const updateQualityParam = (index, field, value) => {
    const checklist = [...qcForm.quality_checklist];
    checklist[index][field] = value;
    setQcForm({ ...qcForm, quality_checklist: checklist });
  };

  const handleApprove = async (status) => {
    const user = await base44.auth.me();
    const allTempPass = qcForm.temperature_logs.every(log => log.meets_standard);
    const allHygienePass = qcForm.hygiene_checklist.every(item => item.status === 'pass');
    const allQualityPass = qcForm.quality_checklist.every(param => param.status === 'pass');

    const overallStatus = status === 'approve' && allTempPass && allHygienePass && allQualityPass 
      ? 'approved' 
      : 'rejected';

    await createQCMutation.mutateAsync({
      batch_id: selectedBatch.id,
      batch_number: selectedBatch.batch_number,
      production_id: selectedBatch.production_id || null,
      recipe_id: selectedBatch.recipe_id || null,
      recipe_name: selectedBatch.recipe_name || null,
      site_id: selectedBatch.site_id,
      site_name: selectedBatch.site_name,
      inspection_date: new Date().toISOString(),
      inspector_name: user.email,
      temperature_logs: qcForm.temperature_logs,
      hygiene_checklist: qcForm.hygiene_checklist,
      quality_checklist: qcForm.quality_checklist,
      overall_status: overallStatus,
      approval_notes: qcForm.approval_notes,
      approved_by: user.email,
      approved_at: new Date().toISOString()
    });

    await updateBatchMutation.mutateAsync({
      id: selectedBatch.id,
      data: {
        qc_status: overallStatus,
        status: overallStatus === 'approved' ? 'qc_approved' : 'cancelled'
      }
    });
  };

  const pendingBatches = batches.filter(b => b.qc_status === 'pending' && b.process_stage === 'completed');
  const approvedToday = qcRecords.filter(qc => 
    qc.overall_status === 'approved' && 
    new Date(qc.inspection_date).toDateString() === new Date().toDateString()
  ).length;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader 
          title="Quality Control" 
          description="Inspect and approve production batches"
        />

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Pending Inspection</p>
                  <p className="text-2xl font-bold text-amber-600">{pendingBatches.length}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-amber-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Approved Today</p>
                  <p className="text-2xl font-bold text-green-600">{approvedToday}</p>
                </div>
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Total Inspections</p>
                  <p className="text-2xl font-bold text-slate-900">{qcRecords.length}</p>
                </div>
                <ClipboardCheck className="w-8 h-8 text-blue-600" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Pending Batches */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Batches Awaiting QC Inspection</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch Number</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Production Date</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingBatches.map(batch => (
                  <TableRow key={batch.id}>
                    <TableCell className="font-medium">{batch.batch_number}</TableCell>
                    <TableCell>{batch.recipe_name}</TableCell>
                    <TableCell>{batch.site_name || 'Not assigned'}</TableCell>
                    <TableCell>{batch.quantity} {batch.unit}</TableCell>
                    <TableCell>{format(new Date(batch.production_date), 'MMM d, yyyy')}</TableCell>
                    <TableCell>
                      <Badge className="bg-blue-600">{batch.process_stage}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button size="sm" onClick={() => startInspection(batch)}>
                        Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {pendingBatches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-500 py-8">
                      No batches pending inspection
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* QC History */}
        <Card>
          <CardHeader>
            <CardTitle>QC Inspection History</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch Number</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Inspector</TableHead>
                  <TableHead>Inspection Date</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {qcRecords.slice(0, 20).map(qc => (
                  <TableRow key={qc.id}>
                    <TableCell className="font-medium">{qc.batch_number}</TableCell>
                    <TableCell>{qc.site_name || 'Not assigned'}</TableCell>
                    <TableCell>{qc.inspector_name}</TableCell>
                    <TableCell>{format(new Date(qc.inspection_date), 'MMM d, yyyy HH:mm')}</TableCell>
                    <TableCell>
                      <Badge className={qc.overall_status === 'approved' ? 'bg-green-600' : 'bg-red-600'}>
                        {qc.overall_status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* QC Inspection Dialog */}
        <Dialog open={showQCDialog} onOpenChange={setShowQCDialog}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Quality Control Inspection - {selectedBatch?.batch_number}</DialogTitle>
            </DialogHeader>

            <div className="space-y-6">
              {/* Temperature Logs */}
              <div>
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Thermometer className="w-4 h-4" />
                  Temperature Logs
                </h3>
                <div className="space-y-2">
                  {qcForm.temperature_logs.map((log, idx) => (
                    <div key={idx} className="grid grid-cols-3 gap-3">
                      <div>
                        <Label className="text-xs">{log.stage}</Label>
                        <p className="text-xs text-slate-500">
                          Range: {TEMPERATURE_STAGES[idx].min}°C - {TEMPERATURE_STAGES[idx].max}°C
                        </p>
                      </div>
                      <Input
                        type="number"
                        value={log.temperature}
                        onChange={(e) => updateTemperature(idx, e.target.value)}
                        placeholder="°C"
                      />
                      <div className="flex items-center">
                        {log.temperature > 0 && (
                          log.meets_standard ? (
                            <Badge className="bg-green-600">Pass</Badge>
                          ) : (
                            <Badge className="bg-red-600">Fail</Badge>
                          )
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Hygiene Checklist */}
              <div>
                <h3 className="font-semibold mb-3">Hygiene Inspection</h3>
                <div className="space-y-2">
                  {qcForm.hygiene_checklist.map((item, idx) => (
                    <div key={idx} className="grid grid-cols-3 gap-3 items-center">
                      <Label className="text-sm">{item.item}</Label>
                      <Select
                        value={item.status}
                        onValueChange={(value) => updateHygieneItem(idx, 'status', value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pass">Pass</SelectItem>
                          <SelectItem value="fail">Fail</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={item.notes}
                        onChange={(e) => updateHygieneItem(idx, 'notes', e.target.value)}
                        placeholder="Notes (optional)"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Quality Parameters */}
              <div>
                <h3 className="font-semibold mb-3">Quality Parameters</h3>
                <div className="space-y-2">
                  {qcForm.quality_checklist.map((param, idx) => (
                    <div key={idx} className="grid grid-cols-3 gap-3 items-center">
                      <Label className="text-sm">{param.parameter}</Label>
                      <Select
                        value={param.status}
                        onValueChange={(value) => updateQualityParam(idx, 'status', value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pass">Pass</SelectItem>
                          <SelectItem value="fail">Fail</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={param.value}
                        onChange={(e) => updateQualityParam(idx, 'value', e.target.value)}
                        placeholder="Observation"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Notes */}
              <div>
                <Label>Approval Notes</Label>
                <Textarea
                  value={qcForm.approval_notes}
                  onChange={(e) => setQcForm({ ...qcForm, approval_notes: e.target.value })}
                  placeholder="Additional notes or observations"
                  className="mt-1"
                  rows={3}
                />
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowQCDialog(false)}>
                Cancel
              </Button>
              <Button 
                variant="destructive"
                onClick={() => handleApprove('reject')}
                disabled={createQCMutation.isPending}
              >
                <XCircle className="w-4 h-4 mr-2" />
                Reject Batch
              </Button>
              <Button 
                onClick={() => handleApprove('approve')}
                disabled={createQCMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Approve Batch
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
