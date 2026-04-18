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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Plus, 
  Clock,
  CheckCircle2,
  Package
} from 'lucide-react';

const PROCESS_STAGES = [
  'cleaning',
  'preparation',
  'cooking',
  'pasteurization',
  'cooling',
  'packaging',
  'completed'
];

const STAGE_COLORS = {
  cleaning: 'bg-blue-500',
  preparation: 'bg-indigo-500',
  cooking: 'bg-orange-500',
  pasteurization: 'bg-red-500',
  cooling: 'bg-cyan-500',
  packaging: 'bg-purple-500',
  completed: 'bg-green-600'
};

export default function BatchTracking() {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showStageDialog, setShowStageDialog] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [batchForm, setBatchForm] = useState({
    recipe_id: '',
    quantity: '',
    production_date: new Date().toISOString().split('T')[0],
    expiry_date: ''
  });
  const [stageNotes, setStageNotes] = useState('');

  const queryClient = useQueryClient();

  const { data: batches = [] } = useQuery({
    queryKey: ['productionBatches'],
    queryFn: () => base44.entities.ProductionBatch.list('-production_date', 100)
  });

  const { data: recipes = [] } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => base44.entities.Recipe.list()
  });

  const createBatchMutation = useMutation({
    mutationFn: async (data) => {
      const batchNumber = `BATCH-${Date.now()}`;
      return base44.entities.ProductionBatch.create({
        ...data,
        batch_number: batchNumber,
        unit: 'servings',
        process_stage: 'cleaning',
        qc_status: 'pending',
        packaging_status: 'pending',
        status: 'in_production',
        process_logs: [{
          stage: 'cleaning',
          started_at: new Date().toISOString(),
          performed_by: (await base44.auth.me()).email,
          notes: 'Batch created and cleaning started'
        }]
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productionBatches'] });
      setShowCreateDialog(false);
      setBatchForm({
        recipe_id: '',
        quantity: '',
        production_date: new Date().toISOString().split('T')[0],
        expiry_date: ''
      });
    }
  });

  const updateStageMutation = useMutation({
    mutationFn: async ({ batch, nextStage }) => {
      const user = await base44.auth.me();
      const logs = batch.process_logs || [];
      
      // Complete current stage
      const currentLog = logs.find(l => l.stage === batch.process_stage && !l.completed_at);
      if (currentLog) {
        currentLog.completed_at = new Date().toISOString();
        currentLog.notes = stageNotes || currentLog.notes;
      }

      // Start next stage
      logs.push({
        stage: nextStage,
        started_at: new Date().toISOString(),
        performed_by: user.email,
        notes: `${nextStage} started`
      });

      return base44.entities.ProductionBatch.update(batch.id, {
        process_stage: nextStage,
        process_logs: logs,
        status: nextStage === 'completed' ? 'qc_pending' : 'in_production'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productionBatches'] });
      setShowStageDialog(false);
      setStageNotes('');
    }
  });

  const handleCreateBatch = () => {
    const recipe = recipes.find(r => r.id === batchForm.recipe_id);
    createBatchMutation.mutate({
      ...batchForm,
      recipe_name: recipe?.name,
      quantity: parseFloat(batchForm.quantity)
    });
  };

  const advanceStage = (batch) => {
    setSelectedBatch(batch);
    setShowStageDialog(true);
  };

  const handleAdvanceStage = () => {
    const currentIndex = PROCESS_STAGES.indexOf(selectedBatch.process_stage);
    if (currentIndex < PROCESS_STAGES.length - 1) {
      const nextStage = PROCESS_STAGES[currentIndex + 1];
      updateStageMutation.mutate({ batch: selectedBatch, nextStage });
    }
  };

  const activeBatches = batches.filter(b => b.status === 'in_production');

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader 
          title="Batch Production Tracking" 
          description="Monitor production batches through all stages"
        >
          <Button onClick={() => setShowCreateDialog(true)} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" />
            Create Batch
          </Button>
        </PageHeader>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Active Batches</p>
                  <p className="text-2xl font-bold text-slate-900">{activeBatches.length}</p>
                </div>
                <Clock className="w-8 h-8 text-indigo-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">QC Approved</p>
                  <p className="text-2xl font-bold text-green-600">
                    {batches.filter(b => b.qc_status === 'approved').length}
                  </p>
                </div>
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Ready for Packaging</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {batches.filter(b => b.qc_status === 'approved' && b.packaging_status === 'pending').length}
                  </p>
                </div>
                <Package className="w-8 h-8 text-purple-600" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Batch List */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {batches.map(batch => {
            const currentStageIndex = PROCESS_STAGES.indexOf(batch.process_stage);
            const progress = ((currentStageIndex + 1) / PROCESS_STAGES.length) * 100;

            return (
              <Card key={batch.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{batch.batch_number}</CardTitle>
                      <p className="text-sm text-slate-600 mt-1">{batch.recipe_name}</p>
                    </div>
                    <Badge className={STAGE_COLORS[batch.process_stage]}>
                      {batch.process_stage}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-slate-600">Quantity:</span>
                      <span className="ml-2 font-medium">{batch.quantity} {batch.unit}</span>
                    </div>
                    <div>
                      <span className="text-slate-600">QC Status:</span>
                      <Badge variant="outline" className="ml-2">
                        {batch.qc_status}
                      </Badge>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span>Progress</span>
                      <span>{progress.toFixed(0)}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div 
                        className="bg-indigo-600 h-2 rounded-full transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  {/* Stage Timeline */}
                  <div className="flex gap-1">
                    {PROCESS_STAGES.map((stage, idx) => (
                      <div
                        key={stage}
                        className={`flex-1 h-1 rounded ${
                          idx <= currentStageIndex ? STAGE_COLORS[stage] : 'bg-slate-200'
                        }`}
                        title={stage}
                      />
                    ))}
                  </div>

                  {batch.status === 'in_production' && (
                    <Button 
                      size="sm" 
                      onClick={() => advanceStage(batch)}
                      disabled={batch.process_stage === 'completed'}
                      className="w-full"
                    >
                      Complete {batch.process_stage} Stage
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Create Batch Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Production Batch</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Recipe *</Label>
                <Select
                  value={batchForm.recipe_id}
                  onValueChange={(value) => setBatchForm({ ...batchForm, recipe_id: value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select recipe" />
                  </SelectTrigger>
                  <SelectContent>
                    {recipes.map(recipe => (
                      <SelectItem key={recipe.id} value={recipe.id}>
                        {recipe.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Quantity (servings) *</Label>
                <Input
                  type="number"
                  value={batchForm.quantity}
                  onChange={(e) => setBatchForm({ ...batchForm, quantity: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Production Date *</Label>
                <Input
                  type="date"
                  value={batchForm.production_date}
                  onChange={(e) => setBatchForm({ ...batchForm, production_date: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Expiry Date</Label>
                <Input
                  type="date"
                  value={batchForm.expiry_date}
                  onChange={(e) => setBatchForm({ ...batchForm, expiry_date: e.target.value })}
                  className="mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleCreateBatch}
                disabled={!batchForm.recipe_id || !batchForm.quantity || createBatchMutation.isPending}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                Create Batch
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Stage Completion Dialog */}
        <Dialog open={showStageDialog} onOpenChange={setShowStageDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Complete {selectedBatch?.process_stage} Stage</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Mark the {selectedBatch?.process_stage} stage as complete and advance to the next stage.
              </p>
              <div>
                <Label>Notes (optional)</Label>
                <Textarea
                  value={stageNotes}
                  onChange={(e) => setStageNotes(e.target.value)}
                  placeholder="Add any notes about this stage..."
                  className="mt-1"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowStageDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleAdvanceStage}
                disabled={updateStageMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Complete Stage
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}