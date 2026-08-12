import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { downloadCSV, downloadExcel } from '@/components/utils/exportData';
import PageHeader from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export default function AuditLogs() {
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [filters, setFilters] = useState({ limit: 500 });
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () => base44.activity.listAuditLogs(filters)
  });
  const logs = data?.logs || [];

  const applyFilters = (event) => {
    event.preventDefault();
    setFilters({ limit: 500, search: search.trim(), action: action.trim(), entity: entity.trim() });
  };

  return (
    <div className="p-4 md:p-8">
      <PageHeader title="Audit Logs" description="Security-safe history of sign-ins, record changes, report access, and background jobs." />
      <Card className="mb-5">
        <CardContent className="p-4">
          <form onSubmit={applyFilters} className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px_220px_auto]">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search user, action, entity, or project" />
            <Input value={action} onChange={(event) => setAction(event.target.value)} placeholder="Action, e.g. LOGIN" />
            <Input value={entity} onChange={(event) => setEntity(event.target.value)} placeholder="Entity, e.g. Recipe" />
            <Button type="submit"><Search className="mr-2 h-4 w-4" />Filter</Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV(logs, 'food-pro-audit-logs')} disabled={!logs.length}><Download className="mr-2 h-4 w-4" />CSV</Button>
            <Button variant="outline" size="sm" onClick={() => downloadExcel(logs, 'food-pro-audit-logs', 'Audit Logs')} disabled={!logs.length}>Excel</Button>
            <span className="self-center text-xs text-slate-500">Sensitive values such as passwords and tokens are redacted by the server.</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-6 text-sm text-slate-500">Loading audit activity…</div>
            : error ? <div className="p-6 text-sm text-red-700">{error.message}</div>
              : !logs.length ? <div className="p-6 text-sm text-slate-500">No audit activity matches the filters.</div>
                : (
                  <div className="max-h-[68vh] overflow-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-white">
                        <TableRow><TableHead>Date</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead>Project</TableHead><TableHead>Details</TableHead></TableRow>
                      </TableHeader>
                      <TableBody>{logs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="whitespace-nowrap align-top text-xs">{formatDate(log.created_at)}</TableCell>
                          <TableCell className="align-top"><div className="font-medium">{log.actor_name || 'System'}</div><div className="text-xs text-slate-500">{log.actor_email || log.role || '—'}</div></TableCell>
                          <TableCell className="align-top"><Badge variant="outline">{log.action}</Badge></TableCell>
                          <TableCell className="align-top"><div>{log.entity}</div><div className="max-w-36 truncate text-xs text-slate-500">{log.entity_id || '—'}</div></TableCell>
                          <TableCell className="align-top text-sm">{log.site_name || log.site_id || 'Global'}</TableCell>
                          <TableCell className="max-w-80 align-top text-xs">
                            <details><summary className="cursor-pointer text-emerald-700">View details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[11px] text-slate-100">{JSON.stringify(log.details || {}, null, 2)}</pre></details>
                          </TableCell>
                        </TableRow>
                      ))}</TableBody>
                    </Table>
                  </div>
                )}
        </CardContent>
      </Card>
    </div>
  );
}
