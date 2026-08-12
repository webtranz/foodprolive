import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Upload } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import BulkJobsTable from '@/components/utilities/BulkJobsTable';
import PageHeader from '@/components/ui/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const IMPORT_MODES = [
  { value: 'keep_existing', label: 'Keep existing data', description: 'Adds valid new records and skips duplicates.' },
  { value: 'replace_existing', label: 'Replace existing data', description: 'Validates the whole file, then replaces authorized records.' },
  { value: 'delete_existing', label: 'Delete existing data', description: 'Deletes authorized records without importing a file.' }
];

export default function BulkUploadCenter() {
  const queryClient = useQueryClient();
  const [moduleKey, setModuleKey] = useState('');
  const [importMode, setImportMode] = useState('keep_existing');
  const [siteId, setSiteId] = useState('all');
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const modulesQuery = useQuery({ queryKey: ['utility-modules'], queryFn: () => base44.utilities.listModules() });
  const sitesQuery = useQuery({ queryKey: ['bulk-upload-sites'], queryFn: () => base44.entities.Site.list('name', 2000) });
  const modules = modulesQuery.data?.modules || [];
  const sites = Array.isArray(sitesQuery.data) ? sitesQuery.data : [];

  useEffect(() => {
    if (!moduleKey && modules.length) setModuleKey(modules[0].key);
  }, [moduleKey, modules]);

  const selectedModule = useMemo(() => modules.find((item) => item.key === moduleKey), [moduleKey, modules]);
  const selectedMode = IMPORT_MODES.find((item) => item.value === importMode);
  const isSiteScoped = selectedModule?.headers?.includes('site_id');

  useEffect(() => {
    if (!isSiteScoped) setSiteId('all');
  }, [isSiteScoped]);

  const submitMutation = useMutation({
    mutationFn: () => {
      const selectedSite = sites.find((site) => site.id === siteId);
      return base44.utilities.submitBulkUpload({
        module: moduleKey,
        import_mode: importMode,
        file: importMode === 'delete_existing' ? null : file,
        site_id: isSiteScoped && siteId !== 'all' ? siteId : '',
        site_name: selectedSite?.name || ''
      });
    },
    onSuccess: (result) => {
      setMessage(`Upload job ${result.job.id} was queued. You can continue using Food Pro while it runs.`);
      setErrorMessage('');
      setFile(null);
      queryClient.invalidateQueries({ queryKey: ['bulk-upload-jobs'] });
    },
    onError: (error) => {
      setMessage('');
      setErrorMessage(error.message || 'The upload job could not be created.');
    }
  });

  const submit = (event) => {
    event.preventDefault();
    setMessage('');
    setErrorMessage('');
    if (!moduleKey) return setErrorMessage('Select a module.');
    if (importMode !== 'delete_existing' && !file) return setErrorMessage('Select a CSV file.');
    submitMutation.mutate();
  };

  return (
    <div className="p-4 md:p-8">
      <PageHeader title="Bulk Upload Center" description="Import large CSV files in background batches without blocking application requests." />

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-lg">Create upload job</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Label>Module</Label>
              <Select value={moduleKey} onValueChange={setModuleKey}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select module" /></SelectTrigger>
                <SelectContent>{modules.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Import mode</Label>
              <Select value={importMode} onValueChange={setImportMode}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{IMPORT_MODES.map((mode) => <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>)}</SelectContent>
              </Select>
              <p className="mt-1 text-xs text-slate-500">{selectedMode?.description}</p>
            </div>
            {isSiteScoped && (
              <div>
                <Label>Project scope</Label>
                <Select value={siteId} onValueChange={setSiteId}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All authorized projects</SelectItem>
                    {sites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {importMode !== 'delete_existing' && (
              <div>
                <Label htmlFor="bulk_csv">CSV file</Label>
                <Input id="bulk_csv" type="file" accept=".csv,text/csv" className="mt-1" onChange={(event) => setFile(event.target.files?.[0] || null)} />
                <p className="mt-1 text-xs text-slate-500">Use the matching template. The default upload limit is 25 MB.</p>
              </div>
            )}
            {['replace_existing', 'delete_existing'].includes(importMode) && (
              <Alert variant="destructive" className="lg:col-span-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Destructive operation</AlertTitle>
                <AlertDescription>{selectedMode?.description} This action is restricted to data within your authorized project scope.</AlertDescription>
              </Alert>
            )}
            {(message || errorMessage) && <div className={`rounded-lg p-3 text-sm lg:col-span-2 ${errorMessage ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{errorMessage || message}</div>}
            <div className="lg:col-span-2">
              <Button type="submit" disabled={submitMutation.isPending}>
                <Upload className="mr-2 h-4 w-4" />{submitMutation.isPending ? 'Queuing…' : 'Queue background job'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-slate-900">Recent upload jobs</h2>
      <BulkJobsTable limit={10} compact />
    </div>
  );
}
