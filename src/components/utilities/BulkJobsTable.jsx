import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const STATUS_STYLES = {
  QUEUED: 'bg-slate-100 text-slate-700',
  PROCESSING: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700'
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function jobProgress(job) {
  if (job.status === 'COMPLETED') return 100;
  const total = Number(job.total_rows) || 0;
  return total > 0 ? Math.min(100, Math.round(((Number(job.processed_rows) || 0) / total) * 100)) : 0;
}

export default function BulkJobsTable({ limit = 100, compact = false }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['bulk-upload-jobs', limit],
    queryFn: () => base44.activity.listBulkUploadJobs(limit),
    refetchInterval: 30000
  });
  useEffect(() => base44.entities.BulkUploadJob.subscribe(() => {
    queryClient.invalidateQueries({ queryKey: ['bulk-upload-jobs'] });
  }), [queryClient]);
  const jobs = data?.jobs || [];

  if (isLoading) return <Card><CardContent className="p-6 text-sm text-slate-500">Loading upload jobs…</CardContent></Card>;
  if (error) return <Card className="border-red-200"><CardContent className="p-6 text-sm text-red-700">{error.message}</CardContent></Card>;
  if (!jobs.length) return <Card><CardContent className="p-6 text-sm text-slate-500">No bulk upload jobs have been submitted.</CardContent></Card>;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module / file</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="min-w-52">Progress</TableHead>
                {!compact && <TableHead>Results</TableHead>}
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => {
                const progress = jobProgress(job);
                const errors = Array.isArray(job.errors) ? job.errors : [];
                return (
                  <TableRow key={job.id}>
                    <TableCell className="align-top">
                      <div className="font-medium text-slate-900">{job.module_key}</div>
                      <div className="max-w-72 truncate text-xs text-slate-500">{job.file_name || 'Delete existing records'}</div>
                      <div className="mt-1 text-xs text-slate-400">{String(job.import_mode || '').replaceAll('_', ' ')}</div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge className={STATUS_STYLES[job.status] || STATUS_STYLES.QUEUED}>{job.status}</Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="mb-2 flex justify-between text-xs text-slate-500">
                        <span>{Number(job.processed_rows) || 0} / {Number(job.total_rows) || 0}</span>
                        <span>{progress}%</span>
                      </div>
                      <Progress value={progress} />
                      <div className="mt-2 text-xs text-slate-500">{job.message || 'Waiting for a background worker.'}</div>
                    </TableCell>
                    {!compact && (
                      <TableCell className="align-top text-xs">
                        <div className="text-emerald-700">Applied: {Number(job.applied_rows) || 0}</div>
                        <div className="text-slate-600">Skipped: {Number(job.skipped_rows) || 0}</div>
                        <div className={Number(job.failed_rows) ? 'text-red-700' : 'text-slate-600'}>Failed: {Number(job.failed_rows) || 0}</div>
                        {errors.length > 0 && (
                          <details className="mt-2 max-w-72">
                            <summary className="cursor-pointer font-medium text-red-700">Show row errors</summary>
                            <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4 text-red-700">
                              {errors.slice(0, 100).map((item, index) => (
                                <li key={`${item.row || 'job'}-${index}`}>Row {item.row || '—'}: {item.message}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap align-top text-xs text-slate-500">
                      {formatDate(job.created_at)}
                      <div className="mt-1">{job.actor_name || job.actor_email || 'System'}</div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
