import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Copy, Download, MessageSquare, Pencil, Plus, QrCode, Trash2 } from 'lucide-react';

const DEFAULT_MEAL_WINDOWS = {
  breakfast: { label: 'Breakfast', start_time: '05:00', end_time: '07:00' },
  lunch: { label: 'Lunch', start_time: '11:00', end_time: '13:00' },
  dinner: { label: 'Dinner', start_time: '17:00', end_time: '20:00' }
};

const emptyForm = {
  employee_name: '',
  company_id_number: '',
  mobile_number: '',
  meal_windows: DEFAULT_MEAL_WINDOWS
};

function formFromRecord(record = {}) {
  return {
    employee_name: record.employee_name || record.name || '',
    company_id_number: record.company_id_number || '',
    mobile_number: record.mobile_number || '',
    meal_windows: {
      breakfast: { ...DEFAULT_MEAL_WINDOWS.breakfast, ...(record.meal_windows?.breakfast || {}) },
      lunch: { ...DEFAULT_MEAL_WINDOWS.lunch, ...(record.meal_windows?.lunch || {}) },
      dinner: { ...DEFAULT_MEAL_WINDOWS.dinner, ...(record.meal_windows?.dinner || {}) }
    }
  };
}

function buildScanUrl(token) {
  if (typeof window === 'undefined' || !token) return '';
  return `${window.location.origin}${createPageUrl('EmployeeMealQRScan')}?token=${encodeURIComponent(token)}`;
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function employeeQrMessage(record) {
  const windows = record.meal_windows || DEFAULT_MEAL_WINDOWS;
  return [
    `Meal QR for ${record.employee_name}`,
    `Company ID: ${record.company_id_number}`,
    '',
    `Breakfast: ${windows.breakfast?.start_time || '05:00'}-${windows.breakfast?.end_time || '07:00'}`,
    `Lunch: ${windows.lunch?.start_time || '11:00'}-${windows.lunch?.end_time || '13:00'}`,
    `Dinner: ${windows.dinner?.start_time || '17:00'}-${windows.dinner?.end_time || '20:00'}`,
    '',
    'Your QR code image is attached. One scan is allowed for each meal per day.'
  ].join('\n');
}

function getQrSvg(record) {
  const svg = document.getElementById(`employee-meal-qr-${record.id}`);
  if (!svg) return null;
  return svg;
}

function downloadQr(record) {
  const svg = getQrSvg(record);
  if (!svg) return null;
  const svgData = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([svgData], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `meal-qr-${record.company_id_number || record.id}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
  return anchor.download;
}

function qrSvgToPngFile(record) {
  const svg = getQrSvg(record);
  if (!svg) {
    return Promise.reject(new Error('Open the QR code before sending it.'));
  }
  const svgData = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const filename = `meal-qr-${record.company_id_number || record.id}.png`;

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 900;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) {
          reject(new Error('QR image could not be generated.'));
          return;
        }
        resolve(new File([blob], filename, { type: 'image/png' }));
      }, 'image/png');
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('QR image could not be prepared.'));
    };
    image.src = url;
  });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyQrImage(file) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
  await navigator.clipboard.write([
    new ClipboardItem({ [file.type]: file })
  ]);
  return true;
}

export default function EmployeeMealQRManager({ canCreate = false }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedQr, setSelectedQr] = useState(null);
  const [editingQr, setEditingQr] = useState(null);
  const [pendingWhatsAppShare, setPendingWhatsAppShare] = useState(null);
  const [shareError, setShareError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const queryClient = useQueryClient();

  const qrQuery = useQuery({
    queryKey: ['staffMealQr'],
    queryFn: () => base44.staffMealQr.list(),
    enabled: canCreate
  });

  const createMutation = useMutation({
    mutationFn: () => base44.staffMealQr.create(form),
    onSuccess: (record) => {
      queryClient.invalidateQueries({ queryKey: ['staffMealQr'] });
      setForm(emptyForm);
      setCreateOpen(false);
      setSelectedQr(record);
    }
  });

  const updateMutation = useMutation({
    mutationFn: () => base44.staffMealQr.update(editingQr.id, form),
    onSuccess: (record) => {
      queryClient.invalidateQueries({ queryKey: ['staffMealQr'] });
      setForm(emptyForm);
      setCreateOpen(false);
      setEditingQr(null);
      setSelectedQr(record);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (record) => base44.staffMealQr.delete(record.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staffMealQr'] });
      setSelectedQr(null);
      setEditingQr(null);
    }
  });

  const records = qrQuery.data || [];
  const saving = createMutation.isPending || updateMutation.isPending;
  const formComplete = Boolean(
    form.employee_name.trim()
    && form.company_id_number.trim()
    && normalizePhone(form.mobile_number)
  );

  const selectedScanUrl = useMemo(() => buildScanUrl(selectedQr?.token), [selectedQr]);

  const setWindowTime = (mealType, field, value) => {
    setForm((current) => ({
      ...current,
      meal_windows: {
        ...current.meal_windows,
        [mealType]: {
          ...current.meal_windows[mealType],
          [field]: value
        }
      }
    }));
  };

  const copyLink = (record) => navigator.clipboard?.writeText(buildScanUrl(record.token));

  const sendQrImageViaWhatsApp = async (record) => {
    const phone = normalizePhone(record.mobile_number);
    if (!phone) {
      alert('Active WhatsApp mobile number is required.');
      return;
    }
    setShareError('');
    try {
      const qrFile = await qrSvgToPngFile(record);
      const shareData = {
        title: `Meal QR - ${record.employee_name}`,
        text: employeeQrMessage(record),
        files: [qrFile]
      };
      if (navigator.canShare?.(shareData) && navigator.share) {
        await navigator.share(shareData);
        return;
      }
      downloadFile(qrFile);
      const copied = await copyQrImage(qrFile).catch(() => false);
      setShareError(copied
        ? 'WhatsApp file sharing is blocked by this browser. The QR image was copied and downloaded; paste or attach it in WhatsApp.'
        : 'WhatsApp file sharing is blocked by this browser. The QR image was downloaded; attach it in WhatsApp.'
      );
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(employeeQrMessage(record))}`, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setShareError(error.message || 'QR image could not be sent.');
    }
  };

  const openAndShareQrImage = (record) => {
    setSelectedQr(record);
    setPendingWhatsAppShare(record.id);
  };

  const openCreateDialog = () => {
    setEditingQr(null);
    setForm(emptyForm);
    setCreateOpen(true);
  };

  const openEditDialog = (record) => {
    setEditingQr(record);
    setForm(formFromRecord(record));
    setCreateOpen(true);
  };

  const closeFormDialog = () => {
    if (saving) return;
    setCreateOpen(false);
    setEditingQr(null);
    setForm(emptyForm);
  };

  const submitForm = () => {
    if (editingQr) {
      updateMutation.mutate();
      return;
    }
    createMutation.mutate();
  };

  const deleteQr = (record) => {
    const name = record.employee_name || record.name || 'this employee';
    if (!window.confirm(`Delete QR employee ${name}? This removes the QR code but keeps existing attendance audit records.`)) {
      return;
    }
    deleteMutation.mutate(record);
  };

  useEffect(() => {
    if (!selectedQr || pendingWhatsAppShare !== selectedQr.id) return;
    const timer = window.setTimeout(() => {
      sendQrImageViaWhatsApp(selectedQr);
      setPendingWhatsAppShare(null);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [pendingWhatsAppShare, selectedQr]);

  if (!canCreate) return null;

  return (
    <>
      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Meal QR Generator</CardTitle>
              <p className="mt-1 text-sm text-slate-500">
                Create employee QR codes with breakfast, lunch, and dinner scan windows. Each employee can scan once per meal per day.
              </p>
            </div>
            <Button type="button" className="bg-emerald-600 hover:bg-emerald-700" onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Create QR Code
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {qrQuery.isLoading ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">Loading employee QR codes...</div>
          ) : records.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
              No employee meal QR codes have been generated yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Company ID</TableHead>
                    <TableHead>WhatsApp</TableHead>
                    <TableHead>Meal Windows</TableHead>
                    <TableHead>Scans</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => {
                    const windows = record.meal_windows || DEFAULT_MEAL_WINDOWS;
                    return (
                      <TableRow key={record.id}>
                        <TableCell className="font-medium">{record.employee_name || record.name}</TableCell>
                        <TableCell>{record.company_id_number}</TableCell>
                        <TableCell>{record.mobile_number}</TableCell>
                        <TableCell className="text-xs text-slate-600">
                          B {windows.breakfast?.start_time}-{windows.breakfast?.end_time}
                          {' '}L {windows.lunch?.start_time}-{windows.lunch?.end_time}
                          {' '}D {windows.dinner?.start_time}-{windows.dinner?.end_time}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{record.scan_history?.length || 0}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => setSelectedQr(record)}>
                              <QrCode className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" size="sm" variant="outline" onClick={() => openAndShareQrImage(record)}>
                              <MessageSquare className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" size="sm" variant="outline" onClick={() => openEditDialog(record)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="border-red-200 text-red-600 hover:bg-red-50"
                              disabled={deleteMutation.isPending}
                              onClick={() => deleteQr(record)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
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

      <Dialog open={createOpen} onOpenChange={(open) => (open ? setCreateOpen(true) : closeFormDialog())}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingQr ? 'Edit Meal QR Code' : 'Create Meal QR Code'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="employee-qr-name">Employee Name *</Label>
              <Input
                id="employee-qr-name"
                className="mt-1"
                value={form.employee_name}
                onChange={(event) => setForm((current) => ({ ...current, employee_name: event.target.value }))}
                placeholder="Enter employee name"
              />
            </div>
            <div>
              <Label htmlFor="employee-qr-company-id">Company ID Number *</Label>
              <Input
                id="employee-qr-company-id"
                className="mt-1"
                value={form.company_id_number}
                onChange={(event) => setForm((current) => ({ ...current, company_id_number: event.target.value }))}
                placeholder="Enter company ID"
              />
            </div>
            <div>
              <Label htmlFor="employee-qr-mobile">Active WhatsApp Mobile *</Label>
              <Input
                id="employee-qr-mobile"
                className="mt-1"
                value={form.mobile_number}
                onChange={(event) => setForm((current) => ({ ...current, mobile_number: event.target.value }))}
                placeholder="Example: +9665XXXXXXXX"
              />
            </div>
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Meal Scan Time Frames</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {Object.entries(form.meal_windows).map(([mealType, window]) => (
                  <div key={mealType} className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-sm font-medium text-slate-800">{window.label}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">From</Label>
                        <Input type="time" value={window.start_time} onChange={(event) => setWindowTime(mealType, 'start_time', event.target.value)} />
                      </div>
                      <div>
                        <Label className="text-xs">To</Label>
                        <Input type="time" value={window.end_time} onChange={(event) => setWindowTime(mealType, 'end_time', event.target.value)} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {(createMutation.isError || updateMutation.isError) && (
              <div className="sm:col-span-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {createMutation.error?.message || updateMutation.error?.message || 'QR code could not be saved.'}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={closeFormDialog}>Cancel</Button>
            <Button
              type="button"
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={!formComplete || saving}
              onClick={submitForm}
            >
              {editingQr ? 'Save Changes' : 'Generate QR Code'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedQr)} onOpenChange={(open) => !open && setSelectedQr(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{selectedQr?.employee_name || selectedQr?.name}</DialogTitle>
          </DialogHeader>
          {selectedQr && (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <p><span className="font-medium">Company ID:</span> {selectedQr.company_id_number}</p>
                <p className="mt-1"><span className="font-medium">WhatsApp:</span> {selectedQr.mobile_number}</p>
              </div>
              <div className="flex justify-center rounded-xl border border-slate-200 bg-white p-4">
                <QRCodeSVG
                  id={`employee-meal-qr-${selectedQr.id}`}
                  value={selectedScanUrl}
                  size={230}
                  level="H"
                  includeMargin
                  fgColor="#0f172a"
                />
              </div>
              <Input readOnly value={selectedScanUrl} />
              <div className="grid grid-cols-3 gap-2">
                <Button type="button" variant="outline" onClick={() => copyLink(selectedQr)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy
                </Button>
                <Button type="button" variant="outline" onClick={() => downloadQr(selectedQr)}>
                  <Download className="mr-2 h-4 w-4" />
                  Save
                </Button>
                <Button type="button" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => sendQrImageViaWhatsApp(selectedQr)}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  WhatsApp
                </Button>
              </div>
              {shareError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {shareError}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
