import React, { useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { format, subDays } from 'date-fns';
import { QRCodeSVG } from 'qrcode.react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { usePermissions } from '@/components/auth/usePermissions';
import PageHeader from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV } from '@/components/utils/exportData';
import {
  AlertTriangle,
  Briefcase,
  Camera,
  CameraOff,
  CheckCircle2,
  Clock3,
  Download,
  Factory,
  FileBarChart2,
  HardHat,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  Users,
  XCircle
} from 'lucide-react';

const todayString = () => format(new Date(), 'yyyy-MM-dd');

const SHIFT_STATUS_TONES = {
  scheduled: 'bg-blue-100 text-blue-700',
  checked_in: 'bg-amber-100 text-amber-700',
  checked_out: 'bg-emerald-100 text-emerald-700',
  absent: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-700'
};

const APPROVAL_TONES = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700'
};

function badgeTone(value, map) {
  return map[String(value || '').toLowerCase()] || 'bg-slate-100 text-slate-700';
}

function parseDateTime(date, time) {
  return new Date(`${date}T${time || '00:00'}:00`);
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function minutesBetween(start, end) {
  const diff = (end.getTime() - start.getTime()) / 60000;
  return Number.isFinite(diff) ? diff : 0;
}

function getScheduledHours(shift = {}) {
  if (!shift.shift_date || !shift.start_time || !shift.end_time) return 0;
  const start = parseDateTime(shift.shift_date, shift.start_time);
  const end = parseDateTime(shift.shift_date, shift.end_time);
  const grossMinutes = Math.max(0, minutesBetween(start, end));
  const netMinutes = Math.max(0, grossMinutes - safeNumber(shift.break_minutes, 0));
  return Number((netMinutes / 60).toFixed(2));
}

function getActualHours(record = {}) {
  if (record.worked_hours) return safeNumber(record.worked_hours);
  if (!record.check_in_at || !record.check_out_at) return 0;
  const workedMinutes = Math.max(0, minutesBetween(new Date(record.check_in_at), new Date(record.check_out_at)));
  return Number((workedMinutes / 60).toFixed(2));
}

function getAttendanceStatus(shift = {}, record = null) {
  if (record?.attendance_status === 'absent') return 'absent';
  if (record?.check_out_at) return 'checked_out';
  if (record?.check_in_at) return 'checked_in';
  if (shift.status === 'cancelled') return 'cancelled';
  return 'scheduled';
}

function getLocationLabel(site = {}) {
  return site.hierarchy_path || site.name || '-';
}

function buildShiftToken(shiftId, action) {
  return btoa(JSON.stringify({
    type: 'foodpro_staff_shift',
    shift_id: shiftId,
    action,
    nonce: Math.random().toString(36).slice(2, 10)
  }));
}

function parseShiftToken(token) {
  try {
    const payload = JSON.parse(atob(token));
    if (payload.type !== 'foodpro_staff_shift') {
      throw new Error('Unsupported QR token');
    }
    return payload;
  } catch {
    throw new Error('Invalid QR token');
  }
}

function sumBy(items = [], selector) {
  return items.reduce((total, item) => total + safeNumber(selector(item)), 0);
}

function formatHours(value) {
  return `${safeNumber(value).toFixed(2)}h`;
}

function formatCurrency(value) {
  return `$${safeNumber(value).toFixed(2)}`;
}

function QRScannerPanel({ onTokenScanned, disabled = false }) {
  const [cameraState, setCameraState] = useState('idle');
  const [manualToken, setManualToken] = useState('');
  const [recentScan, setRecentScan] = useState(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const frameRef = useRef(null);
  const cooldownRef = useRef(false);
  const lastTokenRef = useRef('');

  const stopCamera = () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraState('idle');
  };

  useEffect(() => () => stopCamera(), []);

  const processToken = async (token, source = 'camera') => {
    try {
      const result = await onTokenScanned(token, source);
      setRecentScan({ success: true, message: result.message });
    } catch (error) {
      setRecentScan({ success: false, message: error.message || 'QR scan failed' });
    } finally {
      setManualToken('');
      setTimeout(() => {
        setRecentScan(null);
        lastTokenRef.current = '';
        cooldownRef.current = false;
      }, 2500);
    }
  };

  const scanLoop = () => {
    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
        if (code?.data && code.data !== lastTokenRef.current && !cooldownRef.current) {
          cooldownRef.current = true;
          lastTokenRef.current = code.data;
          processToken(code.data, 'camera');
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  const startCamera = async () => {
    setCameraState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState('active');
      scanLoop();
    } catch {
      setCameraState('denied');
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">QR Scan Station</CardTitle>
            <p className="text-sm text-slate-500 mt-1">Scan staff shift QR codes for check-in and check-out.</p>
          </div>
          <Button
            type="button"
            variant={cameraState === 'active' ? 'outline' : 'default'}
            className={cameraState === 'active' ? 'border-red-200 text-red-700 hover:bg-red-50' : 'bg-emerald-600 hover:bg-emerald-700'}
            onClick={() => (cameraState === 'active' ? stopCamera() : startCamera())}
            disabled={disabled}
          >
            {cameraState === 'active' ? <CameraOff className="w-4 h-4 mr-2" /> : <Camera className="w-4 h-4 mr-2" />}
            {cameraState === 'active' ? 'Stop Camera' : 'Start Camera'}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="relative overflow-hidden rounded-2xl bg-slate-950" style={{ aspectRatio: '16/9' }}>
            {cameraState !== 'active' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                {cameraState === 'starting' ? (
                  <>
                    <Loader2 className="w-10 h-10 text-white/60 animate-spin" />
                    <p className="text-white/70 mt-3">Starting camera...</p>
                  </>
                ) : cameraState === 'denied' ? (
                  <>
                    <CameraOff className="w-10 h-10 text-red-300" />
                    <p className="text-white mt-3">Camera permission denied</p>
                    <p className="text-white/50 text-sm mt-1">Allow camera access and try again.</p>
                  </>
                ) : (
                  <>
                    <QrCode className="w-12 h-12 text-white/20" />
                    <p className="text-white/70 mt-3">Camera is off</p>
                    <p className="text-white/40 text-sm mt-1">Use the scan station on a tablet or phone near the kitchen entrance.</p>
                  </>
                )}
              </div>
            ) : null}

            <video ref={videoRef} className={`h-full w-full object-cover ${cameraState === 'active' ? 'opacity-100' : 'opacity-0'}`} playsInline muted />
            <canvas ref={canvasRef} className="hidden" />

            {cameraState === 'active' && !recentScan ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <div className="relative h-56 w-56">
                  <div className="absolute left-0 top-0 h-9 w-9 rounded-tl-xl border-l-4 border-t-4 border-emerald-400" />
                  <div className="absolute right-0 top-0 h-9 w-9 rounded-tr-xl border-r-4 border-t-4 border-emerald-400" />
                  <div className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-xl border-b-4 border-l-4 border-emerald-400" />
                  <div className="absolute bottom-0 right-0 h-9 w-9 rounded-br-xl border-b-4 border-r-4 border-emerald-400" />
                </div>
                <p className="absolute bottom-6 text-sm text-white/70">Point the camera at a shift QR code.</p>
              </div>
            ) : null}

            {recentScan ? (
              <div className={`absolute inset-0 flex flex-col items-center justify-center text-center px-6 ${recentScan.success ? 'bg-emerald-700/95' : 'bg-red-950/95'}`}>
                {recentScan.success ? <CheckCircle2 className="w-16 h-16 text-white" /> : <XCircle className="w-16 h-16 text-red-200" />}
                <p className="mt-3 text-lg font-semibold text-white">{recentScan.success ? 'Attendance recorded' : 'Scan failed'}</p>
                <p className="mt-1 text-sm text-white/80">{recentScan.message}</p>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Manual Token Entry</CardTitle>
          <p className="text-sm text-slate-500 mt-1">Use this when the QR scanner is unavailable.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Shift Token</Label>
            <Textarea
              rows={6}
              className="mt-1 font-mono text-xs"
              value={manualToken}
              onChange={(event) => setManualToken(event.target.value)}
              placeholder="Paste a staff shift QR token here"
            />
          </div>
          <Button
            type="button"
            className="w-full bg-indigo-600 hover:bg-indigo-700"
            disabled={disabled || !manualToken.trim()}
            onClick={() => {
              cooldownRef.current = true;
              processToken(manualToken.trim(), 'manual_entry');
            }}
          >
            <ShieldCheck className="w-4 h-4 mr-2" />
            Process Token
          </Button>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-medium text-slate-800">Recommended setup</p>
            <p className="mt-1">Place one scan station at each staff entry point and another inside the main kitchen for shift check-out.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Attendance() {
  const queryClient = useQueryClient();
  const { currentUser, isAdmin, isManager, loading: permLoading } = usePermissions();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [shiftDialogOpen, setShiftDialogOpen] = useState(false);
  const [qrDialog, setQrDialog] = useState({ open: false, shift: null });
  const [approvalNote, setApprovalNote] = useState('');
  const [message, setMessage] = useState('');
  const [filters, setFilters] = useState({
    startDate: format(subDays(new Date(), 6), 'yyyy-MM-dd'),
    endDate: todayString(),
    locationId: 'all',
    kitchenId: 'all',
    status: 'all'
  });
  const [shiftForm, setShiftForm] = useState({
    user_id: '',
    shift_date: todayString(),
    site_id: '',
    kitchen_id: 'none',
    start_time: '07:00',
    end_time: '15:00',
    break_minutes: 60,
    hourly_rate: '',
    production_id: 'none',
    notes: ''
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => base44.entities.Site.list()
  });

  const { data: users = [] } = useQuery({
    queryKey: ['usersForScheduling'],
    queryFn: () => base44.entities.User.list('-updated_date', 500),
    enabled: isManager
  });

  const { data: shifts = [] } = useQuery({
    queryKey: ['staffShifts'],
    queryFn: () => base44.entities.StaffShift.list('-shift_date', 1000)
  });

  const { data: attendanceRecords = [] } = useQuery({
    queryKey: ['attendanceRecords'],
    queryFn: () => base44.entities.AttendanceRecord.list('-marked_at', 1000)
  });

  const { data: productions = [] } = useQuery({
    queryKey: ['productionsForLabor'],
    queryFn: () => base44.entities.Production.list('-production_date', 1000)
  });

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const productionMap = useMemo(() => new Map(productions.map((production) => [production.id, production])), [productions]);
  const attendanceByShiftId = useMemo(() => {
    const map = new Map();
    attendanceRecords.forEach((record) => {
      if (!record.shift_id) return;
      const existing = map.get(record.shift_id);
      if (!existing) {
        map.set(record.shift_id, record);
        return;
      }
      const existingTime = existing.check_out_at || existing.check_in_at || existing.marked_at || '';
      const nextTime = record.check_out_at || record.check_in_at || record.marked_at || '';
      if (nextTime >= existingTime) {
        map.set(record.shift_id, record);
      }
    });
    return map;
  }, [attendanceRecords]);

  const locationOptions = useMemo(
    () => sites.filter((site) => site.type !== 'kitchen'),
    [sites]
  );
  const kitchenOptions = useMemo(
    () => sites.filter((site) => site.type === 'kitchen'),
    [sites]
  );

  const isInRange = (dateValue) => dateValue >= filters.startDate && dateValue <= filters.endDate;

  const filteredShifts = useMemo(() => (
    shifts.filter((shift) => {
      if (!shift.shift_date || !isInRange(shift.shift_date)) return false;
      if (filters.locationId !== 'all' && String(shift.site_id) !== String(filters.locationId)) return false;
      if (filters.kitchenId !== 'all' && String(shift.kitchen_id || '') !== String(filters.kitchenId)) return false;
      const record = attendanceByShiftId.get(shift.id);
      const status = getAttendanceStatus(shift, record);
      if (filters.status !== 'all' && status !== filters.status) return false;
      return true;
    })
  ), [shifts, filters, attendanceByShiftId]);

  const filteredRecords = useMemo(() => (
    attendanceRecords.filter((record) => {
      if (!record.shift_date || !isInRange(record.shift_date)) return false;
      if (filters.locationId !== 'all' && String(record.site_id) !== String(filters.locationId)) return false;
      if (filters.kitchenId !== 'all' && String(record.kitchen_id || '') !== String(filters.kitchenId)) return false;
      return true;
    })
  ), [attendanceRecords, filters]);

  const filteredProductions = useMemo(() => (
    productions.filter((production) => {
      const recordDate = production.production_date || '';
      if (!recordDate || !isInRange(recordDate)) return false;
      if (filters.locationId !== 'all' && String(production.site_id) !== String(filters.locationId)) return false;
      return true;
    })
  ), [productions, filters]);

  const today = todayString();
  const todayShifts = useMemo(() => filteredShifts.filter((shift) => shift.shift_date === today), [filteredShifts, today]);
  const todayRecords = useMemo(() => filteredRecords.filter((record) => record.shift_date === today), [filteredRecords, today]);

  const absentShifts = useMemo(() => {
    const now = new Date();
    return filteredShifts.filter((shift) => {
      const record = attendanceByShiftId.get(shift.id);
      if (record) return false;
      if (!shift.shift_date || !shift.end_time) return false;
      const shiftEnd = parseDateTime(shift.shift_date, shift.end_time);
      return shiftEnd < now;
    }).map((shift) => ({
      shift_id: shift.id,
      shift_date: shift.shift_date,
      user_name: shift.user_name,
      site_name: shift.site_name,
      kitchen_name: shift.kitchen_name,
      start_time: shift.start_time,
      end_time: shift.end_time
    }));
  }, [filteredShifts, attendanceByShiftId]);

  const productionHoursMap = useMemo(() => {
    const map = new Map();
    filteredRecords.forEach((record) => {
      if (!record.production_id) return;
      const next = safeNumber(map.get(record.production_id)) + getActualHours(record);
      map.set(record.production_id, next);
    });
    return map;
  }, [filteredRecords]);

  const staffProductivityRows = useMemo(() => {
    const grouped = new Map();

    filteredShifts.forEach((shift) => {
      const key = shift.user_id || shift.user_name || shift.id;
      if (!grouped.has(key)) {
        grouped.set(key, {
          user_name: shift.user_name || 'Unassigned',
          site_name: shift.site_name || '-',
          kitchen_name: shift.kitchen_name || '-',
          shifts: 0,
          scheduled_hours: 0,
          worked_hours: 0,
          overtime_hours: 0,
          labor_cost: 0,
          assigned_output: 0
        });
      }
      const row = grouped.get(key);
      const record = attendanceByShiftId.get(shift.id);
      row.shifts += 1;
      row.scheduled_hours += getScheduledHours(shift);
      row.worked_hours += getActualHours(record);
      row.overtime_hours += safeNumber(record?.overtime_hours);
      row.labor_cost += safeNumber(record?.labor_cost);
      const production = productionMap.get(record?.production_id || shift.production_id);
      row.assigned_output += safeNumber(production?.actual_servings || production?.target_servings);
    });

    return [...grouped.values()]
      .map((row) => ({
        ...row,
        scheduled_hours: Number(row.scheduled_hours.toFixed(2)),
        worked_hours: Number(row.worked_hours.toFixed(2)),
        overtime_hours: Number(row.overtime_hours.toFixed(2)),
        labor_cost: Number(row.labor_cost.toFixed(2)),
        assigned_output: Number(row.assigned_output.toFixed(2)),
        output_per_hour: Number((row.worked_hours > 0 ? row.assigned_output / row.worked_hours : 0).toFixed(2))
      }))
      .sort((left, right) => right.output_per_hour - left.output_per_hour);
  }, [filteredShifts, attendanceByShiftId, productionMap]);

  const locationLaborRows = useMemo(() => {
    const grouped = new Map();
    filteredRecords.forEach((record) => {
      const key = record.site_id || record.site_name || 'unassigned';
      if (!grouped.has(key)) {
        grouped.set(key, {
          site_name: record.site_name || 'Unassigned',
          total_labor_cost: 0,
          worked_hours: 0,
          headcount: new Set()
        });
      }
      const row = grouped.get(key);
      row.total_labor_cost += safeNumber(record.labor_cost);
      row.worked_hours += getActualHours(record);
      if (record.user_id || record.user_name) row.headcount.add(record.user_id || record.user_name);
    });

    return [...grouped.values()].map((row) => ({
      site_name: row.site_name,
      total_labor_cost: Number(row.total_labor_cost.toFixed(2)),
      worked_hours: Number(row.worked_hours.toFixed(2)),
      headcount: row.headcount.size
    })).sort((left, right) => right.total_labor_cost - left.total_labor_cost);
  }, [filteredRecords]);

  const batchLaborRows = useMemo(() => {
    const grouped = new Map();
    filteredShifts.forEach((shift) => {
      const record = attendanceByShiftId.get(shift.id);
      const productionId = record?.production_id || shift.production_id;
      if (!productionId) return;
      const production = productionMap.get(productionId);
      const key = productionId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          production_name: record?.production_name || shift.production_name || production?.recipe_name || 'Production Batch',
          site_name: shift.site_name || production?.site_name || '-',
          production_date: production?.production_date || shift.shift_date,
          labor_cost: 0,
          worked_hours: 0,
          output: safeNumber(production?.actual_servings || production?.target_servings),
          staff_count: new Set()
        });
      }
      const row = grouped.get(key);
      row.labor_cost += safeNumber(record?.labor_cost);
      row.worked_hours += getActualHours(record);
      row.staff_count.add(shift.user_id || shift.user_name || shift.id);
    });

    return [...grouped.values()].map((row) => ({
      ...row,
      labor_cost: Number(row.labor_cost.toFixed(2)),
      worked_hours: Number(row.worked_hours.toFixed(2)),
      cost_per_output: Number((row.output > 0 ? row.labor_cost / row.output : 0).toFixed(2)),
      output_per_staff_hour: Number((row.worked_hours > 0 ? row.output / row.worked_hours : 0).toFixed(2)),
      staff_count: row.staff_count.size
    })).sort((left, right) => right.labor_cost - left.labor_cost);
  }, [filteredShifts, attendanceByShiftId, productionMap]);

  const pendingApprovals = useMemo(() => (
    filteredRecords.filter((record) => record.approval_status !== 'approved' && record.attendance_status !== 'absent')
  ), [filteredRecords]);

  const lateArrivalRows = useMemo(() => (
    filteredRecords
      .filter((record) => safeNumber(record.late_minutes) > 0 || record.attendance_status === 'absent')
      .map((record) => ({
        ...record,
        late_minutes: safeNumber(record.late_minutes)
      }))
      .sort((left, right) => right.late_minutes - left.late_minutes)
  ), [filteredRecords]);

  const todayAttendancePercentage = todayShifts.length > 0
    ? Number(((todayRecords.length / todayShifts.length) * 100).toFixed(1))
    : 0;

  const totalOvertimeHours = Number(sumBy(filteredRecords, (record) => record.overtime_hours).toFixed(2));
  const totalWorkedHours = Number(sumBy(filteredRecords, (record) => getActualHours(record)).toFixed(2));
  const totalLaborCost = Number(sumBy(filteredRecords, (record) => record.labor_cost).toFixed(2));
  const totalProductionOutput = Number(sumBy(filteredProductions, (production) => production.actual_servings || production.target_servings).toFixed(2));
  const productionOutputPerStaffHour = totalWorkedHours > 0
    ? Number((totalProductionOutput / totalWorkedHours).toFixed(2))
    : 0;

  const shiftMutation = useMutation({
    mutationFn: (payload) => base44.entities.StaffShift.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staffShifts'] });
      setShiftDialogOpen(false);
      setShiftForm({
        user_id: '',
        shift_date: todayString(),
        site_id: '',
        kitchen_id: 'none',
        start_time: '07:00',
        end_time: '15:00',
        break_minutes: 60,
        hourly_rate: '',
        production_id: 'none',
        notes: ''
      });
      setMessage('Shift scheduled successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to create shift')
  });

  const recordMutation = useMutation({
    mutationFn: async ({ shift, action, source }) => {
      const now = new Date();
      if (!shift?.shift_date || shift.shift_date !== todayString()) {
        throw new Error('This shift is not scheduled for today.');
      }

      const existingRecord = attendanceByShiftId.get(shift.id);
      const scheduledHours = getScheduledHours(shift);
      const hourlyRate = safeNumber(shift.hourly_rate);
      const production = productionMap.get(shift.production_id);

      if (action === 'check_in') {
        if (existingRecord?.check_in_at) {
          throw new Error(`${shift.user_name} is already checked in.`);
        }
        const scheduledStart = parseDateTime(shift.shift_date, shift.start_time);
        const lateMinutes = Math.max(0, Math.round(minutesBetween(scheduledStart, now)));
        return base44.entities.AttendanceRecord.create({
          shift_id: shift.id,
          user_id: shift.user_id,
          user_name: shift.user_name,
          site_id: shift.site_id,
          site_name: shift.site_name,
          kitchen_id: shift.kitchen_id || null,
          kitchen_name: shift.kitchen_name || null,
          shift_date: shift.shift_date,
          scheduled_start: shift.start_time,
          scheduled_end: shift.end_time,
          scheduled_hours: scheduledHours,
          production_id: shift.production_id || null,
          production_name: shift.production_name || production?.recipe_name || null,
          hourly_rate: hourlyRate,
          check_in_at: now.toISOString(),
          check_out_at: null,
          worked_hours: 0,
          overtime_hours: 0,
          labor_cost: 0,
          late_minutes: lateMinutes,
          scan_method: source,
          attendance_status: 'present',
          approval_status: 'pending',
          status: 'checked_in',
          marked_at: now.toISOString()
        });
      }

      if (!existingRecord?.check_in_at) {
        throw new Error(`${shift.user_name} has not checked in yet.`);
      }

      if (existingRecord?.check_out_at) {
        throw new Error(`${shift.user_name} is already checked out.`);
      }

      const workedMinutes = Math.max(0, minutesBetween(new Date(existingRecord.check_in_at), now) - safeNumber(shift.break_minutes));
      const workedHours = Number((workedMinutes / 60).toFixed(2));
      const overtimeHours = Number(Math.max(0, workedHours - scheduledHours).toFixed(2));
      const regularHours = Math.max(0, workedHours - overtimeHours);
      const laborCost = Number(((regularHours * hourlyRate) + (overtimeHours * hourlyRate * 1.5)).toFixed(2));

      return base44.entities.AttendanceRecord.update(existingRecord.id, {
        check_out_at: now.toISOString(),
        worked_hours: workedHours,
        overtime_hours: overtimeHours,
        labor_cost: laborCost,
        approval_status: 'pending',
        status: 'checked_out',
        marked_at: now.toISOString()
      });
    },
    onSuccess: (_record, variables) => {
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
      setMessage(`${variables.shift.user_name} ${variables.action === 'check_in' ? 'checked in' : 'checked out'} successfully.`);
    },
    onError: (error) => setMessage(error.message || 'Attendance update failed')
  });

  const approvalMutation = useMutation({
    mutationFn: ({ record, status }) => base44.entities.AttendanceRecord.update(record.id, {
      approval_status: status,
      approval_notes: approvalNote || null,
      approved_by: currentUser?.email || null,
      approved_at: new Date().toISOString()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
      setApprovalNote('');
      setMessage('Attendance approval updated.');
    },
    onError: (error) => setMessage(error.message || 'Failed to update approval')
  });

  const absenceMutation = useMutation({
    mutationFn: (shift) => base44.entities.AttendanceRecord.create({
      shift_id: shift.id,
      user_id: shift.user_id,
      user_name: shift.user_name,
      site_id: shift.site_id,
      site_name: shift.site_name,
      kitchen_id: shift.kitchen_id || null,
      kitchen_name: shift.kitchen_name || null,
      shift_date: shift.shift_date,
      scheduled_start: shift.start_time,
      scheduled_end: shift.end_time,
      scheduled_hours: getScheduledHours(shift),
      production_id: shift.production_id || null,
      production_name: shift.production_name || null,
      attendance_status: 'absent',
      approval_status: 'approved',
      status: 'absent',
      late_minutes: 0,
      worked_hours: 0,
      overtime_hours: 0,
      labor_cost: 0,
      scan_method: 'manager_absence',
      marked_at: new Date().toISOString(),
      approved_by: currentUser?.email || null,
      approved_at: new Date().toISOString()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
      setMessage('Absence marked successfully.');
    },
    onError: (error) => setMessage(error.message || 'Failed to mark absence')
  });

  const handleCreateShift = (event) => {
    event.preventDefault();
    const staff = userMap.get(shiftForm.user_id);
    const site = siteMap.get(shiftForm.site_id);
    const kitchen = shiftForm.kitchen_id !== 'none' ? siteMap.get(shiftForm.kitchen_id) : null;
    const production = shiftForm.production_id !== 'none' ? productionMap.get(shiftForm.production_id) : null;

    shiftMutation.mutate({
      user_id: shiftForm.user_id,
      user_name: staff?.full_name || staff?.email || 'Staff Member',
      user_email: staff?.email || null,
      shift_date: shiftForm.shift_date,
      site_id: shiftForm.site_id,
      site_name: site?.name || null,
      site_path: getLocationLabel(site || {}),
      kitchen_id: kitchen?.id || null,
      kitchen_name: kitchen?.name || null,
      start_time: shiftForm.start_time,
      end_time: shiftForm.end_time,
      break_minutes: safeNumber(shiftForm.break_minutes, 0),
      scheduled_hours: getScheduledHours(shiftForm),
      hourly_rate: safeNumber(shiftForm.hourly_rate || staff?.hourly_rate || 0),
      production_id: production?.id || null,
      production_name: production ? `${production.recipe_name || 'Production'} - ${production.production_date}` : null,
      staff_role: staff?.job_title || staff?.role || 'staff',
      notes: shiftForm.notes,
      approval_status: 'pending',
      status: 'scheduled'
    });
  };

  const handleTokenScanned = async (token, source = 'camera') => {
    const payload = parseShiftToken(token);
    const shift = shifts.find((item) => item.id === payload.shift_id);
    if (!shift) {
      throw new Error('Shift not found for this QR code.');
    }
    await recordMutation.mutateAsync({ shift, action: payload.action, source });
    return { message: `${shift.user_name} ${payload.action === 'check_in' ? 'checked in' : 'checked out'}.` };
  };

  const exportAttendance = () => {
    const rows = filteredShifts.map((shift) => {
      const record = attendanceByShiftId.get(shift.id);
      return {
        shift_date: shift.shift_date,
        user_name: shift.user_name,
        site_name: shift.site_name,
        kitchen_name: shift.kitchen_name,
        start_time: shift.start_time,
        end_time: shift.end_time,
        scheduled_hours: getScheduledHours(shift),
        worked_hours: getActualHours(record),
        overtime_hours: safeNumber(record?.overtime_hours),
        labor_cost: safeNumber(record?.labor_cost),
        status: getAttendanceStatus(shift, record),
        approval_status: record?.approval_status || 'pending',
        production_name: shift.production_name
      };
    });
    downloadCSV(rows, 'staff_scheduling_labor');
  };

  if (permLoading) {
    return <div className="p-8 text-slate-500">Loading staff scheduling workspace...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1680px] space-y-6">
        <PageHeader
          title="Staff Scheduling and Labor Cost"
          description="Manage QR attendance, shift scheduling, overtime, staffing assignments, and labor productivity across locations and kitchens"
        >
          <Button variant="outline" onClick={exportAttendance}>
            <Download className="w-4 h-4 mr-2" />
            Export Labor Data
          </Button>
          {isManager ? (
            <Button onClick={() => setShiftDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
              <Plus className="w-4 h-4 mr-2" />
              Schedule Shift
            </Button>
          ) : null}
        </PageHeader>

        {message ? (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            {message}
          </div>
        ) : null}

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <div>
                <Label>Start Date</Label>
                <Input type="date" className="mt-1" value={filters.startDate} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))} />
              </div>
              <div>
                <Label>End Date</Label>
                <Input type="date" className="mt-1" value={filters.endDate} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))} />
              </div>
              <div>
                <Label>Location</Label>
                <Select value={filters.locationId} onValueChange={(value) => setFilters((current) => ({ ...current, locationId: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {locationOptions.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{getLocationLabel(site)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Kitchen</Label>
                <Select value={filters.kitchenId} onValueChange={(value) => setFilters((current) => ({ ...current, kitchenId: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Kitchens</SelectItem>
                    {kitchenOptions.map((site) => (
                      <SelectItem key={site.id} value={site.id}>{getLocationLabel(site)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Status</Label>
                <Select value={filters.status} onValueChange={(value) => setFilters((current) => ({ ...current, status: value }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="checked_in">Checked In</SelectItem>
                    <SelectItem value="checked_out">Checked Out</SelectItem>
                    <SelectItem value="absent">Absent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className={`grid w-full ${isManager ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            {isManager ? <TabsTrigger value="schedules">Shifts</TabsTrigger> : null}
            <TabsTrigger value="attendance">QR Attendance</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-500">Today's Staff On Duty</p><p className="text-3xl font-bold text-slate-900">{todayShifts.length}</p></div><Users className="w-8 h-8 text-indigo-600" /></div></CardContent></Card>
              <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-500">Attendance Percentage</p><p className="text-3xl font-bold text-slate-900">{todayAttendancePercentage}%</p></div><UserCheck className="w-8 h-8 text-emerald-600" /></div></CardContent></Card>
              <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-500">Labor Cost</p><p className="text-3xl font-bold text-slate-900">{formatCurrency(totalLaborCost)}</p></div><Briefcase className="w-8 h-8 text-amber-600" /></div></CardContent></Card>
              <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><p className="text-sm text-slate-500">Output per Staff Hour</p><p className="text-3xl font-bold text-slate-900">{productionOutputPerStaffHour}</p></div><Factory className="w-8 h-8 text-purple-600" /></div></CardContent></Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Today's Staff on Duty</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Kitchen</TableHead>
                        <TableHead>Shift</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {todayShifts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-slate-500">No staff scheduled for today.</TableCell>
                        </TableRow>
                      ) : todayShifts.map((shift) => {
                        const record = attendanceByShiftId.get(shift.id);
                        const status = getAttendanceStatus(shift, record);
                        return (
                          <TableRow key={shift.id}>
                            <TableCell className="font-medium">{shift.user_name}</TableCell>
                            <TableCell>{shift.site_name || '-'}</TableCell>
                            <TableCell>{shift.kitchen_name || '-'}</TableCell>
                            <TableCell>{shift.start_time} - {shift.end_time}</TableCell>
                            <TableCell><Badge className={badgeTone(status, SHIFT_STATUS_TONES)}>{status.replace(/_/g, ' ')}</Badge></TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Labor Cost per Location</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {locationLaborRows.length === 0 ? (
                    <p className="py-10 text-center text-sm text-slate-500">No labor cost records in this range.</p>
                  ) : locationLaborRows.slice(0, 6).map((row) => (
                    <div key={row.site_name} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-900">{row.site_name}</p>
                          <p className="text-xs text-slate-500">{row.headcount} staff • {formatHours(row.worked_hours)}</p>
                        </div>
                        <p className="text-lg font-semibold text-slate-900">{formatCurrency(row.total_labor_cost)}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {isManager ? (
            <TabsContent value="schedules" className="space-y-4">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Shift Schedule</CardTitle>
                    <p className="text-sm text-slate-500 mt-1">Assign staff by location, kitchen, and production batch.</p>
                  </div>
                  <Button onClick={() => setShiftDialogOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                    <Plus className="w-4 h-4 mr-2" />
                    New Shift
                  </Button>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Staff</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Kitchen</TableHead>
                        <TableHead>Production Batch</TableHead>
                        <TableHead>Hours</TableHead>
                        <TableHead>QR</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredShifts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-10 text-center text-slate-500">No shifts found for the selected filters.</TableCell>
                        </TableRow>
                      ) : filteredShifts.map((shift) => {
                        const record = attendanceByShiftId.get(shift.id);
                        return (
                          <TableRow key={shift.id}>
                            <TableCell>{shift.shift_date}</TableCell>
                            <TableCell>
                              <div>
                                <p className="font-medium text-slate-900">{shift.user_name}</p>
                                <p className="text-xs text-slate-500">{shift.staff_role || 'staff'}</p>
                              </div>
                            </TableCell>
                            <TableCell>{shift.site_name || '-'}</TableCell>
                            <TableCell>{shift.kitchen_name || '-'}</TableCell>
                            <TableCell>{shift.production_name || '-'}</TableCell>
                            <TableCell>
                              <div>
                                <p className="text-sm text-slate-900">{shift.start_time} - {shift.end_time}</p>
                                <p className="text-xs text-slate-500">Scheduled {formatHours(getScheduledHours(shift))}</p>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Badge className={badgeTone(getAttendanceStatus(shift, record), SHIFT_STATUS_TONES)}>
                                  {getAttendanceStatus(shift, record).replace(/_/g, ' ')}
                                </Badge>
                                <Button variant="outline" size="sm" onClick={() => setQrDialog({ open: true, shift })}>
                                  <QrCode className="w-4 h-4 mr-2" />
                                  View QR
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          ) : null}

          <TabsContent value="attendance" className="space-y-4">
            <QRScannerPanel onTokenScanned={handleTokenScanned} disabled={recordMutation.isPending} />

            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Attendance Ledger</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff</TableHead>
                        <TableHead>Shift</TableHead>
                        <TableHead>Check-In</TableHead>
                        <TableHead>Check-Out</TableHead>
                        <TableHead>Overtime</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredShifts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="py-10 text-center text-slate-500">No attendance records in this range.</TableCell>
                        </TableRow>
                      ) : filteredShifts.slice(0, 30).map((shift) => {
                        const record = attendanceByShiftId.get(shift.id);
                        const status = getAttendanceStatus(shift, record);
                        return (
                          <TableRow key={shift.id}>
                            <TableCell className="font-medium">{shift.user_name}</TableCell>
                            <TableCell>{shift.shift_date} • {shift.start_time}</TableCell>
                            <TableCell>{record?.check_in_at ? format(new Date(record.check_in_at), 'HH:mm') : '-'}</TableCell>
                            <TableCell>{record?.check_out_at ? format(new Date(record.check_out_at), 'HH:mm') : '-'}</TableCell>
                            <TableCell>{formatHours(record?.overtime_hours)}</TableCell>
                            <TableCell><Badge className={badgeTone(status, SHIFT_STATUS_TONES)}>{status.replace(/_/g, ' ')}</Badge></TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Role-Based Attendance Approval</CardTitle>
                  <p className="text-sm text-slate-500 mt-1">Managers and admins can approve finalized attendance records for payroll and labor costing.</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label>Approval Note</Label>
                    <Textarea rows={3} className="mt-1" value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="Optional note for approval or rejection" />
                  </div>
                  <div className="space-y-3">
                    {pendingApprovals.length === 0 ? (
                      <p className="py-8 text-center text-sm text-slate-500">No pending approvals right now.</p>
                    ) : pendingApprovals.slice(0, 8).map((record) => (
                      <div key={record.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-medium text-slate-900">{record.user_name}</p>
                            <p className="text-xs text-slate-500">{record.shift_date} • {record.site_name || '-'} • {formatHours(record.worked_hours)}</p>
                          </div>
                          <Badge className={badgeTone(record.approval_status, APPROVAL_TONES)}>{record.approval_status || 'pending'}</Badge>
                        </div>
                        {isManager ? (
                          <div className="mt-3 flex gap-2">
                            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => approvalMutation.mutate({ record, status: 'approved' })}>
                              <CheckCircle2 className="w-4 h-4 mr-2" />
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => approvalMutation.mutate({ record, status: 'rejected' })}>
                              <XCircle className="w-4 h-4 mr-2" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-slate-500">Awaiting manager approval.</p>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="reports" className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Staff Productivity Report</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Worked Hours</TableHead>
                        <TableHead>Assigned Output</TableHead>
                        <TableHead>Output / Hour</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {staffProductivityRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-slate-500">No staff productivity data in this range.</TableCell>
                        </TableRow>
                      ) : staffProductivityRows.map((row) => (
                        <TableRow key={`${row.user_name}-${row.site_name}`}>
                          <TableCell className="font-medium">{row.user_name}</TableCell>
                          <TableCell>{row.site_name}</TableCell>
                          <TableCell>{formatHours(row.worked_hours)}</TableCell>
                          <TableCell>{row.assigned_output}</TableCell>
                          <TableCell>{row.output_per_hour}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Late Arrival and Absence Report</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {lateArrivalRows.length === 0 && absentShifts.length === 0 ? (
                    <p className="py-10 text-center text-sm text-slate-500">No late arrivals or absences in this range.</p>
                  ) : (
                    <>
                      {lateArrivalRows.slice(0, 6).map((record) => (
                        <div key={record.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-medium text-slate-900">{record.user_name}</p>
                              <p className="text-xs text-slate-500">{record.shift_date} • {record.site_name || '-'}</p>
                            </div>
                            <Badge className="bg-amber-100 text-amber-700">
                              {record.attendance_status === 'absent' ? 'Absent' : `${record.late_minutes} min late`}
                            </Badge>
                          </div>
                        </div>
                      ))}
                      {absentShifts.slice(0, 6).map((shift) => (
                        <div key={shift.shift_id} className="rounded-xl border border-red-200 bg-red-50 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-medium text-slate-900">{shift.user_name}</p>
                              <p className="text-xs text-slate-500">{shift.shift_date} • {shift.site_name || '-'}</p>
                            </div>
                            {isManager ? (
                              <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-100" onClick={() => absenceMutation.mutate(shifts.find((item) => item.id === shift.shift_id))}>
                                <AlertTriangle className="w-4 h-4 mr-2" />
                                Mark Absent
                              </Button>
                            ) : (
                              <Badge className="bg-red-100 text-red-700">No record</Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Labor Cost per Production Batch</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Batch</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Labor Cost</TableHead>
                        <TableHead>Staff Hours</TableHead>
                        <TableHead>Output / Hour</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batchLaborRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-slate-500">No production-linked labor data available.</TableCell>
                        </TableRow>
                      ) : batchLaborRows.map((row) => (
                        <TableRow key={`${row.production_name}-${row.production_date}`}>
                          <TableCell className="font-medium">{row.production_name}</TableCell>
                          <TableCell>{row.site_name}</TableCell>
                          <TableCell>{formatCurrency(row.labor_cost)}</TableCell>
                          <TableCell>{formatHours(row.worked_hours)}</TableCell>
                          <TableCell>{row.output_per_staff_hour}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Operations Snapshot</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm text-slate-500">Overtime Hours</p>
                        <p className="text-2xl font-bold text-slate-900">{totalOvertimeHours}</p>
                      </div>
                      <Clock3 className="w-7 h-7 text-amber-600" />
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm text-slate-500">Total Worked Hours</p>
                        <p className="text-2xl font-bold text-slate-900">{totalWorkedHours}</p>
                      </div>
                      <Users className="w-7 h-7 text-indigo-600" />
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm text-slate-500">Production Output</p>
                        <p className="text-2xl font-bold text-slate-900">{totalProductionOutput}</p>
                      </div>
                      <FileBarChart2 className="w-7 h-7 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        <Dialog open={shiftDialogOpen} onOpenChange={setShiftDialogOpen}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Schedule Staff Shift</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateShift} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Staff Member</Label>
                  <Select
                    value={shiftForm.user_id}
                    onValueChange={(value) => {
                      const selectedUser = userMap.get(value);
                      setShiftForm((current) => ({
                        ...current,
                        user_id: value,
                        hourly_rate: String(selectedUser?.hourly_rate || current.hourly_rate || '')
                      }));
                    }}
                  >
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select staff member" /></SelectTrigger>
                    <SelectContent>
                      {users.filter((user) => user.role !== 'admin').map((user) => (
                        <SelectItem key={user.id} value={user.id}>{user.full_name || user.email}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Shift Date</Label>
                  <Input type="date" className="mt-1" value={shiftForm.shift_date} onChange={(event) => setShiftForm((current) => ({ ...current, shift_date: event.target.value }))} />
                </div>
                <div>
                  <Label>Location</Label>
                  <Select value={shiftForm.site_id} onValueChange={(value) => setShiftForm((current) => ({ ...current, site_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Select location" /></SelectTrigger>
                    <SelectContent>
                      {locationOptions.map((site) => (
                        <SelectItem key={site.id} value={site.id}>{getLocationLabel(site)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Kitchen</Label>
                  <Select value={shiftForm.kitchen_id} onValueChange={(value) => setShiftForm((current) => ({ ...current, kitchen_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No kitchen assignment</SelectItem>
                      {kitchenOptions.map((site) => (
                        <SelectItem key={site.id} value={site.id}>{getLocationLabel(site)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Start Time</Label>
                  <Input type="time" className="mt-1" value={shiftForm.start_time} onChange={(event) => setShiftForm((current) => ({ ...current, start_time: event.target.value }))} />
                </div>
                <div>
                  <Label>End Time</Label>
                  <Input type="time" className="mt-1" value={shiftForm.end_time} onChange={(event) => setShiftForm((current) => ({ ...current, end_time: event.target.value }))} />
                </div>
                <div>
                  <Label>Break Minutes</Label>
                  <Input type="number" min="0" className="mt-1" value={shiftForm.break_minutes} onChange={(event) => setShiftForm((current) => ({ ...current, break_minutes: event.target.value }))} />
                </div>
                <div>
                  <Label>Hourly Rate</Label>
                  <Input type="number" min="0" step="0.01" className="mt-1" value={shiftForm.hourly_rate} onChange={(event) => setShiftForm((current) => ({ ...current, hourly_rate: event.target.value }))} placeholder="0.00" />
                </div>
                <div className="md:col-span-2">
                  <Label>Production Batch</Label>
                  <Select value={shiftForm.production_id} onValueChange={(value) => setShiftForm((current) => ({ ...current, production_id: value }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No production batch</SelectItem>
                      {productions
                        .filter((production) => !shiftForm.site_id || production.site_id === shiftForm.site_id)
                        .map((production) => (
                          <SelectItem key={production.id} value={production.id}>
                            {production.recipe_name || 'Production'} - {production.production_date} - {production.site_name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea rows={4} className="mt-1" value={shiftForm.notes} onChange={(event) => setShiftForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Kitchen assignment details, supervisor note, or batch instructions" />
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-medium text-slate-800">Scheduled hours</p>
                <p className="mt-1">{formatHours(getScheduledHours(shiftForm))} will be used as the standard labor target for overtime and productivity calculations.</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShiftDialogOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-emerald-600 hover:bg-emerald-700" disabled={shiftMutation.isPending || !shiftForm.user_id || !shiftForm.site_id}>
                  {shiftMutation.isPending ? 'Scheduling...' : 'Create Shift'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={qrDialog.open} onOpenChange={(open) => setQrDialog((current) => ({ ...current, open }))}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>Shift QR Codes</DialogTitle>
            </DialogHeader>
            {qrDialog.shift ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="font-medium text-slate-900">{qrDialog.shift.user_name}</p>
                  <p className="text-sm text-slate-500">{qrDialog.shift.shift_date} • {qrDialog.shift.site_name || '-'} • {qrDialog.shift.kitchen_name || 'No kitchen'}</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {[
                    { action: 'check_in', label: 'Check-In', icon: LogIn, tone: 'bg-emerald-50 border-emerald-200' },
                    { action: 'check_out', label: 'Check-Out', icon: LogOut, tone: 'bg-indigo-50 border-indigo-200' }
                  ].map((item) => {
                    const token = buildShiftToken(qrDialog.shift.id, item.action);
                    return (
                      <div key={item.action} className={`rounded-2xl border p-5 ${item.tone}`}>
                        <div className="flex items-center gap-2">
                          <item.icon className="w-5 h-5 text-slate-700" />
                          <p className="font-medium text-slate-900">{item.label} QR</p>
                        </div>
                        <div className="mt-4 flex justify-center rounded-2xl bg-white p-4">
                          <QRCodeSVG value={token} size={220} level="H" includeMargin fgColor="#0f172a" />
                        </div>
                        <p className="mt-3 text-xs break-all text-slate-500">{token}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setQrDialog({ open: false, shift: null })}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
