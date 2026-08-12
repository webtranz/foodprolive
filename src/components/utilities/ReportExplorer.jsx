import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import { downloadCSV, downloadExcel, downloadPDF } from '@/components/utils/exportData';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function displayValue(value) {
  if (value === null || typeof value === 'undefined' || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function ReportExplorer({ allowExports = true }) {
  const { can } = usePermissions();
  const [moduleKey, setModuleKey] = useState('');
  const modulesQuery = useQuery({ queryKey: ['utility-modules'], queryFn: () => base44.utilities.listModules() });
  const modules = modulesQuery.data?.modules || [];

  useEffect(() => {
    if (!moduleKey && modules.length) setModuleKey(modules[0].key);
  }, [moduleKey, modules]);

  const reportQuery = useQuery({
    queryKey: ['utility-report', moduleKey],
    queryFn: () => base44.utilities.getReport(moduleKey, 1000),
    enabled: Boolean(moduleKey)
  });
  const rows = reportQuery.data?.rows || [];
  const headers = useMemo(() => Array.from(new Set(rows.flatMap((row) => Object.keys(row || {})))), [rows]);
  const visibleHeaders = headers.slice(0, 16);
  const selectedModule = modules.find((item) => item.key === moduleKey);
  const canExport = allowExports && can('export_data');
  const filename = `${moduleKey || 'food-pro'}-report`;

  const exportPdf = () => {
    downloadPDF({
      title: `${selectedModule?.label || 'Food Pro'} Report`,
      subtitle: `${rows.length} authorized rows. PDF preview includes the first 100 rows and 8 columns.`,
      filename,
      sections: [{
        heading: 'Report data',
        lines: rows.slice(0, 100).map((row) => visibleHeaders.slice(0, 8).map((key) => `${key}: ${displayValue(row[key])}`).join(' | '))
      }]
    });
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Report dataset</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Select value={moduleKey} onValueChange={setModuleKey}>
            <SelectTrigger className="w-full lg:w-80"><SelectValue placeholder="Select a module" /></SelectTrigger>
            <SelectContent>{modules.map((item) => <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          {canExport && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => downloadCSV(rows, filename)} disabled={!rows.length}><Download className="mr-2 h-4 w-4" />CSV</Button>
              <Button variant="outline" onClick={() => downloadExcel(rows, filename, 'Food Pro')} disabled={!rows.length}><FileSpreadsheet className="mr-2 h-4 w-4" />Excel</Button>
              <Button variant="outline" onClick={exportPdf} disabled={!rows.length}><FileText className="mr-2 h-4 w-4" />PDF</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{selectedModule?.label || 'Report preview'} <span className="font-normal text-slate-500">({rows.length} rows)</span></CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {reportQuery.isLoading ? <div className="p-6 text-sm text-slate-500">Loading authorized report data…</div>
            : reportQuery.error ? <div className="p-6 text-sm text-red-700">{reportQuery.error.message}</div>
              : !rows.length ? <div className="p-6 text-sm text-slate-500">No authorized records are available for this report.</div>
                : (
                  <div className="max-h-[60vh] overflow-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-white">
                        <TableRow>{visibleHeaders.map((key) => <TableHead key={key} className="whitespace-nowrap">{key.replaceAll('_', ' ')}</TableHead>)}</TableRow>
                      </TableHeader>
                      <TableBody>{rows.slice(0, 250).map((row, index) => (
                        <TableRow key={row.id || index}>{visibleHeaders.map((key) => <TableCell key={key} className="max-w-64 truncate">{displayValue(row[key])}</TableCell>)}</TableRow>
                      ))}</TableBody>
                    </Table>
                  </div>
                )}
        </CardContent>
      </Card>
      {headers.length > visibleHeaders.length && <p className="text-xs text-slate-500">The on-screen preview shows the first 16 columns. Exports include every authorized column.</p>}
      {rows.length > 250 && <p className="text-xs text-slate-500">The on-screen preview shows the first 250 rows. Exports include all {rows.length} loaded rows.</p>}
    </div>
  );
}
