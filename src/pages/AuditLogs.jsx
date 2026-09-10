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

function humanize(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function recordName(record = {}) {
  return record.name
    || record.ingredient_name
    || record.recipe_name
    || record.site_name
    || record.reference_number
    || record.production_number
    || record.id
    || '';
}

function formatDetailValue(value) {
  if (value === null || typeof value === 'undefined' || value === '') return 'blank';
  if (typeof value === 'number') return Number.isFinite(value)
    ? Number(value.toFixed(6)).toLocaleString(undefined, { maximumFractionDigits: 6 })
    : 'not available';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return recordName(value) || 'updated details';
  return String(value);
}

function summarizeFieldChanges(before = {}, after = {}) {
  const ignored = new Set(['updated_date', 'created_date', 'last_login', 'password_hash']);
  return Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]))
    .filter((field) => !ignored.has(field))
    .filter((field) => {
      const previous = before?.[field];
      const next = after?.[field];
      if (typeof previous === 'object' || typeof next === 'object') return false;
      return JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null);
    })
    .slice(0, 8)
    .map((field) => `${humanize(field)} changed from ${formatDetailValue(before?.[field])} to ${formatDetailValue(after?.[field])}.`);
}

function buildAuditNarrative(log) {
  const details = log.details || {};
  const actor = log.actor_name || log.actor_email || 'System';
  const entity = humanize(log.entity || 'record');
  const action = humanize(log.action || 'activity');
  const site = log.site_name || log.site_id || 'Global';

  const summary = details.friendly_summary
    || `${actor} performed ${action}${entity ? ` on ${entity}` : ''}${log.entity_id ? ` ${log.entity_id}` : ''} at ${site}.`;

  const bullets = [];
  if (Array.isArray(details.friendly_changes)) bullets.push(...details.friendly_changes);
  if (Array.isArray(details.inventory_delete_impact?.effects)) bullets.push(...details.inventory_delete_impact.effects);
  if (details.deleted_record) bullets.push(`Deleted record: ${recordName(details.deleted_record) || log.entity_id || 'record'}.`);
  if (details.created_record) bullets.push(`Created record: ${recordName(details.created_record) || log.entity_id || 'record'}.`);
  if (details.before && details.after) bullets.push(...summarizeFieldChanges(details.before, details.after));
  if (details.module && details.rows !== undefined) bullets.push(`${details.rows} row${Number(details.rows) === 1 ? '' : 's'} were included in ${humanize(details.module)}.`);
  if (!bullets.length && details.input) {
    const fields = Object.keys(details.input).filter((key) => !['password', 'token'].includes(String(key).toLowerCase())).slice(0, 8);
    if (fields.length) bullets.push(`Fields involved: ${fields.map(humanize).join(', ')}.`);
  }

  return {
    summary,
    bullets: Array.from(new Set(bullets)).slice(0, 12)
  };
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
      <PageHeader title="Audit Logs" description="Plain-language history of sign-ins, record changes, report access, and background jobs for reverse troubleshooting." />
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
                        <TableRow><TableHead>Date</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead>Project</TableHead><TableHead>What happened</TableHead></TableRow>
                      </TableHeader>
                      <TableBody>{logs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="whitespace-nowrap align-top text-xs">{formatDate(log.created_at)}</TableCell>
                          <TableCell className="align-top"><div className="font-medium">{log.actor_name || 'System'}</div><div className="text-xs text-slate-500">{log.actor_email || log.role || '—'}</div></TableCell>
                          <TableCell className="align-top"><Badge variant="outline">{humanize(log.action)}</Badge></TableCell>
                          <TableCell className="align-top"><div>{log.entity}</div><div className="max-w-36 truncate text-xs text-slate-500">{log.entity_id || '—'}</div></TableCell>
                          <TableCell className="align-top text-sm">{log.site_name || log.site_id || 'Global'}</TableCell>
                          <TableCell className="min-w-[420px] max-w-[720px] align-top text-sm">
                            {(() => {
                              const narrative = buildAuditNarrative(log);
                              return (
                                <div className="space-y-2">
                                  <p className="font-medium text-slate-900">{narrative.summary}</p>
                                  {narrative.bullets.length ? (
                                    <ul className="list-disc space-y-1 pl-5 text-slate-600">
                                      {narrative.bullets.map((item) => (
                                        <li key={item}>{item}</li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <p className="text-xs text-slate-500">No additional change details were recorded.</p>
                                  )}
                                  <details>
                                    <summary className="cursor-pointer text-xs font-medium text-emerald-700">Technical data</summary>
                                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[11px] text-slate-100">{JSON.stringify(log.details || {}, null, 2)}</pre>
                                  </details>
                                </div>
                              );
                            })()}
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
