import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function humanize(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clampProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function formatJobType(value) {
  return humanize(value || 'background_job');
}

const JOB_STATUS_TONE = {
  PREPARING: 'bg-sky-100 text-sky-700',
  QUEUED: 'bg-blue-100 text-blue-700',
  PROCESSING: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  SKIPPED: 'bg-slate-100 text-slate-700',
  FAILED: 'bg-rose-100 text-rose-700',
  CANCELLED: 'bg-slate-100 text-slate-700'
};

export default function BackgroundJobMonitor() {
  const [backgroundJobs, setBackgroundJobs] = useState([]);
  const backgroundJobCursorRef = useRef('');
  const backgroundJobLimit = 75;
  const {
    data: backgroundJobData,
    isLoading,
    isFetching,
    error
  } = useQuery({
    queryKey: ['background-jobs-monitor'],
    queryFn: ({ signal }) => base44.activity.listBackgroundJobs({
      limit: backgroundJobLimit,
      updated_after: backgroundJobCursorRef.current,
      signal
    }),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
    retry: 1,
    staleTime: 8000
  });

  useEffect(() => {
    if (!backgroundJobData) return;
    const incomingJobs = Array.isArray(backgroundJobData.jobs) ? backgroundJobData.jobs : [];
    setBackgroundJobs((currentJobs) => {
      if (!backgroundJobData.incremental) {
        return incomingJobs.slice(0, backgroundJobLimit);
      }
      if (!incomingJobs.length) return currentJobs;
      const merged = new Map(currentJobs.map((job) => [job.id, job]));
      incomingJobs.forEach((job) => merged.set(job.id, job));
      return [...merged.values()]
        .sort((left, right) => new Date(right.queued_at || right.updated_at || 0).getTime() - new Date(left.queued_at || left.updated_at || 0).getTime())
        .slice(0, backgroundJobLimit);
    });
    if (backgroundJobData.next_updated_after) {
      const cursorTime = new Date(backgroundJobData.next_updated_after).getTime();
      backgroundJobCursorRef.current = Number.isFinite(cursorTime)
        ? new Date(Math.max(0, cursorTime - 1000)).toISOString()
        : backgroundJobData.next_updated_after;
    }
  }, [backgroundJobData]);

  return (
    <div className="p-4 md:p-8">
      <PageHeader
        title="Background Job Monitor"
        description="Admin-only queue status using one lightweight refresh every 10 seconds."
      />

      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Queue trace</h2>
              <p className="text-sm text-slate-500">Shows durable job status and progress without loading audit details.</p>
            </div>
            <div className="flex items-center gap-2">
              {isFetching && backgroundJobs.length ? <Badge variant="outline">Refreshing every 10s…</Badge> : null}
              {error && backgroundJobs.length ? <Badge className="bg-amber-100 text-amber-700">Retrying</Badge> : null}
              <Badge variant="outline">{backgroundJobs.length} recent jobs</Badge>
            </div>
          </div>
          {isLoading && !backgroundJobs.length ? (
            <div className="rounded border border-slate-200 p-4 text-sm text-slate-500">Loading background jobs…</div>
          ) : error && !backgroundJobs.length ? (
            <div className="rounded border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error.message}</div>
          ) : !backgroundJobs.length ? (
            <div className="rounded border border-slate-200 p-4 text-sm text-slate-500">No background jobs have been recorded yet.</div>
          ) : (
            <div className="max-h-[72vh] overflow-auto rounded border border-slate-200">
              <Table>
                <TableHeader className="sticky top-0 bg-white">
                  <TableRow>
                    <TableHead>Queued</TableHead>
                    <TableHead>Job</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backgroundJobs.map((job) => {
                    const progress = clampProgress(job.progress);
                    const status = String(job.status || 'QUEUED').toUpperCase();
                    return (
                      <TableRow key={job.id}>
                        <TableCell className="whitespace-nowrap align-top text-xs">{formatDate(job.queued_at)}</TableCell>
                        <TableCell className="align-top">
                          <div className="font-medium text-slate-900">{formatJobType(job.job_type)}</div>
                          <div className="max-w-52 truncate text-xs text-slate-500">{job.id}</div>
                          <div className="text-xs text-slate-500">{job.actor_name || job.actor_email || 'System'}</div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge className={JOB_STATUS_TONE[status] || 'bg-slate-100 text-slate-700'}>{humanize(status)}</Badge>
                          {job.total_items ? (
                            <div className="mt-1 text-xs text-slate-500">
                              {job.completed_items}/{job.total_items} complete
                              {job.failed_items ? ` · ${job.failed_items} failed` : ''}
                              {job.processing_items ? ` · ${job.processing_items} processing` : ''}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="min-w-48 align-top">
                          <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                            <span>{progress.toFixed(0)}%</span>
                            <span>{formatDate(job.last_progress_at || job.updated_at)}</span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full ${status === 'FAILED' ? 'bg-rose-500' : status === 'COMPLETED' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          <div>{job.entity_name || '—'}</div>
                          <div className="max-w-44 truncate text-xs text-slate-500">{job.entity_id || '—'}</div>
                        </TableCell>
                        <TableCell className="max-w-[520px] align-top text-sm">
                          <div className="text-slate-700">{job.last_progress_message || job.message || '—'}</div>
                          {job.error ? <div className="mt-1 text-xs text-rose-700">{job.error}</div> : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
